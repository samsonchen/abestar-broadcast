// Following one joined broadcast: initial fetch, Realtime, gap re-fetch, idle notice and end (PLAN.md §5.2).
// The Supabase specifics live behind `Backend` (supabase.ts), so the Broadcast-from-Database swap stays local.
import type { Segment, Session } from '@abestar/shared';
import { type Change, Transcript } from './transcript';

export type JoinResult =
  | { ok: true; session: Session }
  | { ok: false; error: 'invalid-pin' | 'too-many-attempts' | 'network' };

export interface Backend {
  join(pin: string): Promise<JoinResult>;
  /** The session row and the segments updated at or after `since` (all when null). Throws when it fails. */
  fetch(
    sessionId: string,
    since: string | null,
  ): Promise<{ session: Session | null; segments: Segment[] }>;
  /** Returns a function that unsubscribes. */
  subscribe(
    sessionId: string,
    on: {
      segment(row: Segment): void;
      session(row: Session): void;
      /** Postgres Changes is attached: on the first join and again after every reconnect. */
      attached(): void;
      lost(): void;
    },
  ): () => void;
}

export type Status = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'ended';

export interface View {
  status(status: Status): void;
  /** The session row as last read or pushed, e.g. when read-aloud becomes available. */
  session(session: Session): void;
  changes(changes: Change[]): void;
  idle(idle: boolean): void;
}

export interface Options {
  idleMs: number;
  retryMs: number;
}

const DEFAULTS: Options = { idleMs: 10 * 60_000, retryMs: 5000 };

export class LiveSession {
  readonly transcript = new Transcript();
  private attached = false;
  private everAttached = false;
  private online = true;
  private fetchFailed = false;
  private ended = false;
  private reported: Status | null = null;
  private unsubscribe: (() => void) | null = null;
  private syncing: Promise<void> | null = null;
  private again = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly options: Options;

  constructor(
    private readonly backend: Backend,
    readonly session: Session,
    private readonly view: View,
    options: Partial<Options> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  start(): Promise<void> {
    this.unsubscribe = this.backend.subscribe(this.session.id, {
      segment: (row) => this.apply([row]),
      session: (row) => {
        this.view.session(row);
        if (row.status === 'ended') this.end();
      },
      attached: () => {
        this.attached = this.everAttached = true;
        // Changes made while the channel was down were not delivered.
        void this.resync();
      },
      lost: () => {
        this.attached = false;
        this.report();
      },
    });
    this.armIdle();
    this.report();
    return this.resync();
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.report();
    if (online) void this.resync();
  }

  /** Fetches what changed since the newest row seen. Call it when a sleeping phone wakes up, too. */
  resync(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.again = false;
        clearTimeout(this.retryTimer);
        try {
          const { session, segments } = await this.backend.fetch(
            this.session.id,
            this.transcript.lastUpdatedAt,
          );
          this.fetchFailed = false;
          if (session) this.view.session(session);
          this.apply(segments);
          if (!session || session.status === 'ended') return this.end();
        } catch {
          this.fetchFailed = true;
          this.retryTimer = setTimeout(() => void this.resync(), this.options.retryMs);
        }
        this.report();
      } while (this.again && !this.ended);
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.unsubscribe?.();
    clearTimeout(this.retryTimer);
    clearTimeout(this.idleTimer);
    this.view.idle(false);
    this.report();
  }

  private apply(rows: Segment[]): void {
    if (this.ended) return;
    const changes = this.transcript.merge(rows);
    if (changes.length === 0) return;
    this.view.changes(changes);
    this.view.idle(false);
    this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.view.idle(true), this.options.idleMs);
  }

  private report(): void {
    const status: Status = this.ended
      ? 'ended'
      : !this.online
        ? 'offline'
        : this.attached && !this.fetchFailed
          ? 'live'
          : this.everAttached
            ? 'reconnecting'
            : 'connecting';
    if (status === this.reported) return;
    this.reported = status;
    this.view.status(status);
  }
}
