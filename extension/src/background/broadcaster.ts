// The background worker's logic (PLAN.md §4.4), free of chrome.* so it can be unit-tested.
//
// State lives in memory and is written through to session storage after every change, so a worker that
// Chrome stops and restarts picks up the broadcast, epoch and unsent lines where it left off.

import type { CaptureMessage } from '@abestar/shared';
import type {
  Broadcast,
  BroadcastState,
  HelloReply,
  StartReply,
  Status,
  ToContent,
} from '../messages';
import { IDLE_STATE } from '../messages';
import type { Api } from './api';

export interface QueueItem {
  epoch: number;
  seq: number;
  text: string;
}

export interface Store {
  load(): Promise<{ state?: BroadcastState; queue?: QueueItem[] }>;
  save(state: BroadcastState, queue: QueueItem[]): Promise<void>;
}

export interface Deps {
  api: Api;
  store: Store;
  getToken(): Promise<string | undefined>;
  getDebounceMs(): Promise<number>;
  /** Sends to the content script in a tab; false if nothing answered (not an Abestar page). */
  tell(tabId: number, message: ToContent): Promise<boolean>;
  showStatus(status: Status): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

export const MAX_BACKOFF_MS = 30_000;

export class Broadcaster {
  private state: BroadcastState = { ...IDLE_STATE };
  private queue: QueueItem[] = [];
  private readonly ready: Promise<void>;
  private flushing: Promise<void> | null = null;
  private retryScheduled = false;
  private backoffMs = 1000;

  constructor(private readonly deps: Deps) {
    this.ready = deps.store.load().then(({ state, queue }) => {
      if (state) this.state = state;
      if (queue) this.queue = queue;
      deps.showStatus(this.state.status);
    });
  }

  async getState(): Promise<BroadcastState> {
    await this.ready;
    return this.state;
  }

  async start(opts: { tabId: number; title: string; force: boolean }): Promise<StartReply> {
    await this.ready;
    if (this.state.broadcast) return { ok: false, error: 'busy' };
    const token = await this.deps.getToken();
    if (!token) return { ok: false, error: 'no-token' };
    if (!(await this.deps.tell(opts.tabId, { kind: 'ping' })))
      return { ok: false, error: 'not-abestar' };

    const res = await this.deps.api.startSession(token, opts.title, opts.force);
    if (!res.ok) {
      if (res.error === 'session-live') return { ok: false, error: 'session-live' };
      if (res.error === 'invalid-token') return { ok: false, error: 'invalid-token' };
      return { ok: false, error: 'network', message: res.message };
    }

    const broadcast: Broadcast = {
      sessionId: res.value.id,
      pin: res.value.pin,
      title: opts.title,
      tabId: opts.tabId,
      epoch: 0,
      startedAt: Date.now(),
    };
    this.queue = [];
    this.backoffMs = 1000;
    await this.update({ broadcast, status: 'live', sent: 0, lastError: null });
    await this.deps.tell(opts.tabId, {
      kind: 'start',
      debounceMs: await this.deps.getDebounceMs(),
    });
    return { ok: true };
  }

  async end(): Promise<void> {
    await this.ready;
    const { broadcast } = this.state;
    if (!broadcast) return;
    await this.flush();
    const token = await this.deps.getToken();
    if (token) await this.deps.api.endSession(token, broadcast.sessionId);
    await this.deps.tell(broadcast.tabId, { kind: 'stop' });
    this.queue = [];
    await this.update({ ...IDLE_STATE });
  }

  /** The presenter acknowledged that the broadcast was ended elsewhere. */
  async dismiss(): Promise<void> {
    await this.ready;
    if (this.state.status === 'ended-remotely') await this.update({ ...IDLE_STATE });
  }

  /** A content script (re)loaded; tell it whether to capture. */
  async hello(tabId: number): Promise<HelloReply> {
    await this.ready;
    if (this.state.broadcast?.tabId !== tabId) return { capture: false };
    // A reload: whatever Abestar shows now is not new.
    return { capture: true, debounceMs: await this.deps.getDebounceMs() };
  }

  async capture(tabId: number, message: CaptureMessage): Promise<void> {
    await this.ready;
    const { broadcast } = this.state;
    if (!broadcast || broadcast.tabId !== tabId) return;

    if (message.kind === 'reset') {
      await this.update({ broadcast: { ...broadcast, epoch: broadcast.epoch + 1 } });
    } else if (message.kind === 'status') {
      if (message.status === 'column-not-found') await this.update({ status: 'column-not-found' });
      else if (message.status === 'ok' && this.state.status !== 'reconnecting')
        await this.update({ status: 'live' });
    } else {
      const item = { epoch: broadcast.epoch, seq: message.seq, text: message.text };
      const i = this.queue.findIndex((q) => q.epoch === item.epoch && q.seq === item.seq);
      // Not yet sent: only the newest text matters.
      if (i > 0 || (i === 0 && !this.flushing)) this.queue[i] = item;
      else this.queue.push(item);
      await this.update({});
      void this.flush();
    }
  }

  async tabClosed(tabId: number): Promise<void> {
    await this.ready;
    if (this.state.broadcast?.tabId === tabId) await this.update({ status: 'tab-closed' });
  }

  /** Sends queued lines in order; one flush at a time. Also called by the worker's periodic alarm. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async drain(): Promise<void> {
    await this.ready;
    const token = await this.deps.getToken();
    while (this.queue.length > 0 && this.state.broadcast) {
      const item = this.queue[0] as QueueItem;
      if (!token) return this.update({ status: 'invalid-token', lastError: 'No broadcast token' });

      const res = await this.deps.api.upsertSegment(
        token,
        this.state.broadcast.sessionId,
        item.epoch,
        item.seq,
        item.text,
      );
      if (res.ok) {
        this.queue.shift();
        this.backoffMs = 1000;
        const status = this.state.status === 'reconnecting' ? 'live' : this.state.status;
        await this.update({ sent: this.state.sent + 1, status, lastError: null });
      } else if (res.error === 'session-not-live') {
        // Ended elsewhere: another presenter started a broadcast, or the 2-hour auto-end.
        await this.deps.tell(this.state.broadcast.tabId, { kind: 'stop' });
        this.queue = [];
        return this.update({ ...IDLE_STATE, status: 'ended-remotely', lastError: res.message });
      } else if (res.error === 'invalid-token') {
        return this.update({ status: 'invalid-token', lastError: res.message });
      } else {
        await this.update({ status: 'reconnecting', lastError: res.message });
        this.scheduleRetry();
        return;
      }
    }
  }

  private scheduleRetry() {
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.deps.setTimeout(() => {
      this.retryScheduled = false;
      void this.flush();
    }, delay);
  }

  private async update(patch: Partial<BroadcastState>): Promise<void> {
    const before = this.state.status;
    this.state = { ...this.state, ...patch, queued: this.queue.length };
    if (this.state.status !== before) this.deps.showStatus(this.state.status);
    await this.deps.store.save(this.state, this.queue);
  }
}
