// M3: background worker logic with fake chrome/Supabase dependencies (PLAN.md §4.4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api, ApiResult } from '../src/background/api';
import { Broadcaster, type Deps, type QueueItem, type Store } from '../src/background/broadcaster';
import type { BroadcastState, ToContent } from '../src/messages';

const TAB = 7;
const OTHER_TAB = 8;

/** Session storage that survives a "worker restart" (a new Broadcaster over the same store). */
function memoryStore(): Store & { data: { state?: BroadcastState; queue?: QueueItem[] } } {
  const data: { state?: BroadcastState; queue?: QueueItem[] } = {};
  return {
    data,
    load: async () => structuredClone(data),
    save: async (state, queue) => {
      data.state = structuredClone(state);
      data.queue = structuredClone(queue);
    },
  };
}

function fakeApi() {
  const written: { epoch: number; seq: number; text: string }[] = [];
  let failures: ApiResult<null>[] = [];
  const api = {
    startSession: vi.fn<Api['startSession']>(async () => ({
      ok: true,
      value: { id: 'session-1', pin: '482913' },
    })),
    upsertSegment: vi.fn<Api['upsertSegment']>(async (_t, _s, epoch, seq, text) => {
      const failure = failures.shift();
      if (failure) return failure;
      written.push({ epoch, seq, text });
      return { ok: true, value: null };
    }),
    endSession: vi.fn<Api['endSession']>(async () => ({ ok: true, value: null })),
  };
  return {
    api,
    written,
    failNext: (...results: ApiResult<null>[]) => (failures = results),
  };
}

const network: ApiResult<null> = { ok: false, error: 'network', message: 'Failed to fetch' };

let store: ReturnType<typeof memoryStore>;
let fake: ReturnType<typeof fakeApi>;
let told: { tabId: number; message: ToContent }[];
let token: string | undefined;

function worker(overrides: Partial<Deps> = {}) {
  return new Broadcaster({
    api: fake.api,
    store,
    getToken: async () => token,
    getDebounceMs: async () => 400,
    tell: async (tabId, message) => {
      told.push({ tabId, message });
      return tabId === TAB || tabId === OTHER_TAB;
    },
    showStatus: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    ...overrides,
  });
}

async function live(b = worker()) {
  expect(
    await b.start({ tabId: TAB, title: 'Talk', includeExisting: false, force: false }),
  ).toEqual({
    ok: true,
  });
  return b;
}

const line = (seq: number, text: string) =>
  ({ kind: 'segment', seq, text, lang: 'en-US' }) as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  store = memoryStore();
  fake = fakeApi();
  told = [];
  token = 'token';
});

afterEach(() => vi.useRealTimers());

describe('starting', () => {
  it('creates a session and tells the tab to capture', async () => {
    const b = await live();
    expect(fake.api.startSession).toHaveBeenCalledWith('token', 'Talk', false);
    expect(told.at(-1)).toEqual({
      tabId: TAB,
      message: { kind: 'start', includeExisting: false, debounceMs: 400 },
    });
    expect(await b.getState()).toMatchObject({
      status: 'live',
      broadcast: { sessionId: 'session-1', pin: '482913', tabId: TAB, epoch: 0 },
    });
  });

  it('needs a token', async () => {
    token = undefined;
    expect(
      await worker().start({ tabId: TAB, title: 'T', includeExisting: false, force: false }),
    ).toEqual({
      ok: false,
      error: 'no-token',
    });
  });

  it('refuses a tab without the content script, before creating a session', async () => {
    const reply = await worker().start({
      tabId: 99,
      title: 'T',
      includeExisting: false,
      force: false,
    });
    expect(reply).toEqual({ ok: false, error: 'not-abestar' });
    expect(fake.api.startSession).not.toHaveBeenCalled();
  });

  it('reports a live session elsewhere, and starts with force', async () => {
    fake.api.startSession.mockResolvedValueOnce({ ok: false, error: 'session-live', message: '' });
    const b = worker();
    const opts = { tabId: TAB, title: 'T', includeExisting: false };
    expect(await b.start({ ...opts, force: false })).toEqual({ ok: false, error: 'session-live' });
    expect(await b.start({ ...opts, force: true })).toEqual({ ok: true });
    expect(fake.api.startSession).toHaveBeenLastCalledWith('token', 'T', true);
  });

  it('allows only one broadcasting tab', async () => {
    const b = await live();
    expect(
      await b.start({ tabId: OTHER_TAB, title: 'T', includeExisting: false, force: false }),
    ).toEqual({
      ok: false,
      error: 'busy',
    });
  });
});

describe('sending lines', () => {
  it('stamps the epoch, which every reset advances', async () => {
    const b = await live();
    await b.capture(TAB, { kind: 'reset', reason: 'load' });
    await b.capture(TAB, line(1, 'One.'));
    await b.capture(TAB, { kind: 'reset', reason: 'clear' });
    await b.capture(TAB, line(1, 'One again.'));
    await b.flush();

    expect(fake.written).toEqual([
      { epoch: 1, seq: 1, text: 'One.' },
      { epoch: 2, seq: 1, text: 'One again.' },
    ]);
    expect(await b.getState()).toMatchObject({ sent: 2, queued: 0 });
  });

  it('ignores other tabs and anything while idle', async () => {
    const idle = worker();
    await idle.capture(TAB, line(1, 'Nobody is broadcasting.'));
    const b = await live();
    await b.capture(OTHER_TAB, line(1, 'Wrong tab.'));
    await b.flush();
    expect(fake.written).toEqual([]);
  });

  it('retries with backoff while offline and recovers', async () => {
    const b = await live();
    fake.failNext(network, network);
    await b.capture(TAB, line(1, 'Offline line.'));
    await b.flush();
    expect(await b.getState()).toMatchObject({ status: 'reconnecting', queued: 1 });

    await vi.advanceTimersByTimeAsync(1000); // first retry fails again
    expect(await b.getState()).toMatchObject({ status: 'reconnecting' });
    await vi.advanceTimersByTimeAsync(2000); // second retry, doubled delay, succeeds
    expect(fake.written).toEqual([{ epoch: 0, seq: 1, text: 'Offline line.' }]);
    expect(await b.getState()).toMatchObject({ status: 'live', sent: 1, queued: 0 });
  });

  it('caps the backoff at 30 seconds', async () => {
    const delays: number[] = [];
    const b = await live(
      worker({
        setTimeout: (fn, ms) => {
          delays.push(ms);
          return setTimeout(fn, ms);
        },
      }),
    );
    fake.failNext(...Array<ApiResult<null>>(8).fill(network));
    await b.capture(TAB, line(1, 'x'));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('loses nothing when the worker restarts with lines queued', async () => {
    const first = await live();
    fake.failNext(network);
    await first.capture(TAB, { kind: 'reset', reason: 'load' });
    await first.capture(TAB, line(3, 'Queued before the restart.'));
    await first.flush();

    const second = worker(); // Chrome stopped the worker; a new one loads session storage
    expect(await second.getState()).toMatchObject({ queued: 1, broadcast: { epoch: 1 } });
    await second.flush();
    expect(fake.written).toEqual([{ epoch: 1, seq: 3, text: 'Queued before the restart.' }]);
  });

  it('keeps only the newest text of a line that has not been sent yet', async () => {
    const b = await live();
    fake.failNext(network);
    await b.capture(TAB, line(1, 'First.'));
    await b.flush();
    await b.capture(TAB, line(2, 'Draft.'));
    await b.capture(TAB, line(2, 'Final.'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.written.map((w) => w.text)).toEqual(['First.', 'Final.']);
  });

  it('stops when the session was ended elsewhere', async () => {
    const b = await live();
    fake.failNext({ ok: false, error: 'session-not-live', message: 'session_not_live' });
    await b.capture(TAB, line(1, 'Too late.'));
    await b.flush();
    expect(await b.getState()).toMatchObject({
      status: 'ended-remotely',
      broadcast: null,
      queued: 0,
    });
    expect(told.at(-1)).toEqual({ tabId: TAB, message: { kind: 'stop' } });

    await b.dismiss();
    expect(await b.getState()).toMatchObject({ status: 'idle' });
  });

  it('keeps lines and asks for the token when it is rejected', async () => {
    const b = await live();
    fake.failNext({ ok: false, error: 'invalid-token', message: 'invalid_token' });
    await b.capture(TAB, line(1, 'Kept.'));
    await b.flush();
    expect(await b.getState()).toMatchObject({ status: 'invalid-token', queued: 1 });
  });
});

describe('page and session lifecycle', () => {
  it('tells only the broadcasting tab to resume after a reload', async () => {
    const b = await live();
    expect(await b.hello(TAB)).toEqual({ capture: true, includeExisting: false, debounceMs: 400 });
    expect(await b.hello(OTHER_TAB)).toEqual({ capture: false });
  });

  it('reports a missing column and a closed tab', async () => {
    const b = await live();
    await b.capture(TAB, { kind: 'status', status: 'column-not-found' });
    expect((await b.getState()).status).toBe('column-not-found');
    await b.capture(TAB, { kind: 'status', status: 'ok' });
    expect((await b.getState()).status).toBe('live');
    await b.tabClosed(TAB);
    expect((await b.getState()).status).toBe('tab-closed');
  });

  it('sends queued lines, ends the session and stops capture on end', async () => {
    const b = await live();
    await b.capture(TAB, line(1, 'Last words.'));
    await b.end();
    expect(fake.written).toHaveLength(1);
    expect(fake.api.endSession).toHaveBeenCalledWith('token', 'session-1');
    expect(told.at(-1)).toEqual({ tabId: TAB, message: { kind: 'stop' } });
    expect(await b.getState()).toMatchObject({ status: 'idle', broadcast: null });
  });
});
