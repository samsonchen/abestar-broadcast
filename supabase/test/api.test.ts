// Integration test through the real API (PostgREST, Auth, Realtime) of the local stack.
// Run with `npm run test:db` after `supabase start`; it ends the seeded demo session.
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { supabaseBackend } from '../../viewer/src/supabase';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
// The Supabase CLI's fixed local publishable key; not a secret.
const KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const TOKEN = 'local-dev-token';
const QUIET_MS = 1000;

const client = () => createClient(URL, KEY, { auth: { persistSession: false } });

const upsert = (sb: SupabaseClient, sessionId: string, seq: number, text: string) =>
  sb.rpc('upsert_segment', {
    p_token: TOKEN,
    p_session_id: sessionId,
    p_epoch: 0,
    p_seq: seq,
    p_text: text,
  });

/** Collects Postgres Changes events for one session and lets a test wait for the next one. */
async function watch(sb: SupabaseClient, sessionId: string) {
  const events: { table: string; type: string; row: Record<string, unknown> }[] = [];
  const channel: RealtimeChannel = sb
    .channel(`test-${sessionId}-${Math.random()}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'segments', filter: `session_id=eq.${sessionId}` },
      (p) => events.push({ table: 'segments', type: p.eventType, row: p.new }),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
      (p) => events.push({ table: 'sessions', type: p.eventType, row: p.new }),
    );
  // SUBSCRIBED arrives before Postgres Changes is attached; changes made in between are lost,
  // so wait for the extension's own confirmation.
  const attached = new Promise<void>((resolve) =>
    channel.on('system', {}, (m: { extension?: string; status?: string }) => {
      if (m.extension === 'postgres_changes' && m.status === 'ok') resolve();
    }),
  );
  await new Promise<void>((resolve, reject) =>
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status !== 'CLOSED') reject(err ?? new Error(status));
    }),
  );
  await attached;
  return {
    events,
    /** Waits for an event that matches, including one that already arrived. */
    async find(match: (event: (typeof events)[number]) => boolean, timeoutMs = 5000) {
      const start = Date.now();
      for (;;) {
        const found = events.find(match);
        if (found) return found;
        if (Date.now() - start > timeoutMs) throw new Error('no matching realtime event');
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async next(timeoutMs = 3000) {
      const seen = events.length;
      const start = Date.now();
      while (events.length === seen) {
        if (Date.now() - start > timeoutMs) throw new Error('no realtime event');
        await new Promise((r) => setTimeout(r, 20));
      }
      return events[seen] as (typeof events)[number];
    },
    close: () => sb.removeChannel(channel),
  };
}

describe('API end to end (local stack)', () => {
  const extension = client();
  const viewer = client();
  const stranger = client();
  let sessionId: string;
  let pin: string;

  beforeAll(async () => {
    const { data, error } = await extension.rpc('start_session', {
      p_token: TOKEN,
      p_title: 'Integration test',
      p_target_lang: 'en-US',
      p_force: true,
    });
    if (error) throw error;
    ({ id: sessionId, pin } = data as { id: string; pin: string });
    for (const sb of [viewer, stranger]) {
      const { error: authError } = await sb.auth.signInAnonymously();
      if (authError) throw authError;
    }
  });

  afterAll(async () => {
    await extension.rpc('end_session', { p_token: TOKEN, p_session_id: sessionId });
    await Promise.all([viewer, stranger].map((sb) => sb.removeAllChannels()));
  });

  it('maps a wrong token to HTTP 401', async () => {
    const { error, status } = await extension.rpc('start_session', {
      p_token: 'wrong',
      p_title: 'x',
    });
    expect(status).toBe(401);
    expect(error?.message).toBe('invalid_token');
  });

  it('maps starting over a live session to HTTP 409', async () => {
    const { error, status } = await extension.rpc('start_session', {
      p_token: TOKEN,
      p_title: 'x',
    });
    expect(status).toBe(409);
    expect(error?.message).toBe('session_live');
  });

  it('lets an anonymous viewer join with the PIN', async () => {
    const { data } = await viewer.rpc('join_session', { p_pin: pin });
    expect(data).toMatchObject({ session: { id: sessionId, status: 'live' } });
  });

  it('pushes inserts and revisions to the joined viewer only, within a second', async () => {
    const joined = await watch(viewer, sessionId);
    const outsider = await watch(stranger, sessionId);

    const sentAt = Date.now();
    expect((await upsert(extension, sessionId, 1, 'Hello world.')).error).toBeNull();
    const inserted = await joined.next();
    expect(Date.now() - sentAt).toBeLessThan(1000);
    expect(inserted).toMatchObject({
      table: 'segments',
      type: 'INSERT',
      row: { text: 'Hello world.' },
    });

    // A retried identical upsert must not produce an event.
    expect((await upsert(extension, sessionId, 1, 'Hello world.')).error).toBeNull();
    await expect(joined.next(QUIET_MS)).rejects.toThrow('no realtime event');

    expect((await upsert(extension, sessionId, 1, 'Hello, world.')).error).toBeNull();
    expect(await joined.next()).toMatchObject({
      type: 'UPDATE',
      row: { text: 'Hello, world.', prev_text: 'Hello world.', version: 2 },
    });

    expect(outsider.events).toEqual([]);
    await Promise.all([joined.close(), outsider.close()]);
  });

  it('gives a late joiner every line, past the 1000-row page limit', async () => {
    const LINES = 1200;
    for (let from = 100; from < 100 + LINES; from += 100) {
      const writes = Array.from({ length: 100 }, (_, i) =>
        upsert(extension, sessionId, from + i, `Line ${from + i}.`),
      );
      for (const { error } of await Promise.all(writes)) expect(error).toBeNull();
    }

    const late = supabaseBackend({ supabaseUrl: URL, publishableKey: KEY });
    expect(await late.join(pin)).toMatchObject({ ok: true });
    const { segments } = await late.fetch(sessionId, null);
    // Seq 1 is the line written by the previous test.
    expect(segments.map((s) => s.seq)).toEqual([
      1,
      ...Array.from({ length: LINES }, (_, i) => 100 + i),
    ]);

    // The gap re-fetch pages the same way.
    // Lines written concurrently: start from the oldest, rounded down to the millisecond.
    const oldest = Math.min(...segments.slice(1).map((s) => Date.parse(s.updated_at)));
    const { segments: again } = await late.fetch(sessionId, new Date(oldest).toISOString());
    expect(again.map((s) => s.seq)).toEqual(segments.slice(1).map((s) => s.seq));
  }, 60_000);

  it('tells the viewer when the session ends, then refuses writes and reads', async () => {
    const joined = await watch(viewer, sessionId);
    await extension.rpc('end_session', { p_token: TOKEN, p_session_id: sessionId });
    // Realtime may still be delivering the previous test's lines.
    expect(await joined.find((e) => e.table === 'sessions')).toMatchObject({
      row: { status: 'ended' },
    });

    const late = await upsert(extension, sessionId, 2, 'Late line.');
    expect(late.status).toBe(410);

    const { data } = await viewer.from('segments').select('*').eq('session_id', sessionId);
    expect(data).toEqual([]);
    await joined.close();
  });
});
