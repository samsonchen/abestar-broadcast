// The viewer's follow loop with a fake backend (PLAN.md §5.2).
import type { Segment, Session } from '@abestar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Backend, LiveSession, type Status } from '../src/live';
import { row, SESSION } from './rows';

function fakeBackend() {
  let server: { session: Session; segments: Segment[] } = { session: SESSION, segments: [] };
  let handlers: Parameters<Backend['subscribe']>[1] | null = null;
  let failFetch = 0;
  const backend = {
    join: vi.fn<Backend['join']>(),
    fetch: vi.fn<Backend['fetch']>(async (_id, since) => {
      if (failFetch-- > 0) throw new Error('Failed to fetch');
      return {
        session: server.session,
        segments: server.segments.filter((s) => !since || s.updated_at >= since),
      };
    }),
    subscribe: vi.fn<Backend['subscribe']>((_id, on) => {
      handlers = on;
      return () => (handlers = null);
    }),
  };
  return {
    backend,
    get on() {
      if (!handlers) throw new Error('not subscribed');
      return handlers;
    },
    get subscribed() {
      return handlers !== null;
    },
    /** Rows written while no Realtime event reached the viewer. */
    write: (...rows: Segment[]) => server.segments.push(...rows),
    end: () => (server = { ...server, session: { ...SESSION, status: 'ended' }, segments: [] }),
    failNextFetches: (n: number) => (failFetch = n),
  };
}

let fake: ReturnType<typeof fakeBackend>;
let statuses: Status[];
let idle: boolean[];

function follow() {
  const live = new LiveSession(fake.backend, SESSION, {
    status: (s) => statuses.push(s),
    session: () => {},
    changes: () => {},
    idle: (i) => idle.push(i),
  });
  return live;
}
const texts = (live: LiveSession) => live.transcript.segments.map((s) => s.text);

beforeEach(() => {
  vi.useFakeTimers();
  fake = fakeBackend();
  statuses = [];
  idle = [];
});
afterEach(() => vi.useRealTimers());

describe('LiveSession', () => {
  it('shows history, then goes live once Postgres Changes is attached', async () => {
    fake.write(row(0, 1, 'Before I joined.'));
    const live = follow();
    await live.start();
    expect(texts(live)).toEqual(['Before I joined.']);
    expect(statuses).toEqual(['connecting']);

    fake.on.attached();
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('live'));
    fake.on.segment(row(0, 2, 'Live line.'));
    expect(texts(live)).toEqual(['Before I joined.', 'Live line.']);
  });

  it('catches up on rows missed while the channel was down', async () => {
    const live = follow();
    await live.start();
    fake.on.attached();
    fake.write(row(0, 1, 'Seen.', 1, 1));
    fake.on.segment(row(0, 1, 'Seen.', 1, 1));

    fake.on.lost();
    expect(statuses.at(-1)).toBe('reconnecting');
    fake.write(row(0, 2, 'Missed.', 1, 2), row(0, 3, 'Missed too.', 1, 3));
    fake.on.attached();
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('live'));
    expect(texts(live)).toEqual(['Seen.', 'Missed.', 'Missed too.']);
    expect(fake.backend.fetch).toHaveBeenLastCalledWith(
      SESSION.id,
      '2026-10-22T10:00:01.000000+00:00',
    );
  });

  it('reports offline and catches up when back online', async () => {
    const live = follow();
    await live.start();
    fake.on.attached();
    live.setOnline(false);
    expect(statuses.at(-1)).toBe('offline');
    fake.write(row(0, 1, 'While offline.'));
    live.setOnline(true);
    await vi.waitFor(() => expect(texts(live)).toEqual(['While offline.']));
    expect(statuses.at(-1)).toBe('live');
  });

  it('retries a failed fetch', async () => {
    fake.failNextFetches(1);
    fake.write(row(0, 1, 'Eventually.'));
    const live = follow();
    await live.start();
    fake.on.attached();
    expect(texts(live)).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(texts(live)).toEqual(['Eventually.']);
    expect(statuses.at(-1)).toBe('live');
  });

  it('ends on the Realtime status change, keeps its lines and stops listening', async () => {
    fake.write(row(0, 1, 'Last line.'));
    const live = follow();
    await live.start();
    fake.on.attached();
    fake.on.session({ ...SESSION, status: 'ended' });
    expect(statuses.at(-1)).toBe('ended');
    expect(fake.subscribed).toBe(false);
    expect(texts(live)).toEqual(['Last line.']);
    await live.resync();
    expect(fake.backend.fetch).toHaveBeenCalledTimes(2); // start + attached, none after the end
  });

  it('notices an end it slept through when the page becomes visible', async () => {
    const live = follow();
    await live.start();
    fake.on.attached();
    fake.end();
    await live.resync();
    expect(statuses.at(-1)).toBe('ended');
  });

  it('shows the idle notice after 10 minutes without a line', async () => {
    const live = follow();
    await live.start();
    fake.on.attached();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    fake.on.segment(row(0, 1, 'Still talking.'));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(idle.includes(true)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idle.at(-1)).toBe(true);
    fake.on.segment(row(0, 2, 'Back.'));
    expect(idle.at(-1)).toBe(false);
    expect(texts(live)).toHaveLength(2);
  });
});
