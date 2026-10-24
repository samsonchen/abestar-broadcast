// TTS through the real local stack: database trigger → pg_net → Edge Function `tts` → ElevenLabs stub →
// tts_deliver → private Realtime channel (docs/tts-plan.md §11). Needs supabase/functions/.env (from .env.example).
import type { TtsClip } from '@abestar/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
// The Supabase CLI's fixed local publishable key; not a secret.
const KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const TOKEN = 'local-dev-token';

const client = () => createClient(URL, KEY, { auth: { persistSession: false } });

/** Joins the session's audio channel and collects clips. */
async function listen(sb: SupabaseClient, sessionId: string) {
  const clips: TtsClip[] = [];
  const channel = sb
    .channel(`tts:${sessionId}`, { config: { private: true } })
    .on('broadcast', { event: 'audio' }, ({ payload }) => clips.push(payload as TtsClip));
  const status = await new Promise<string>((resolve) =>
    channel.subscribe((s) => {
      if (s !== 'CLOSED') resolve(s);
    }),
  );
  return {
    status,
    clips,
    async next(timeoutMs = 8000) {
      const seen = clips.length;
      const start = Date.now();
      while (clips.length === seen) {
        if (Date.now() - start > timeoutMs) throw new Error('no clip');
        await new Promise((r) => setTimeout(r, 50));
      }
      return clips[seen] as TtsClip;
    },
    close: () => sb.removeChannel(channel),
  };
}

describe('read-aloud end to end (local stack)', () => {
  const extension = client();
  const listener = client();
  const stranger = client();
  let sessionId: string;
  let line = 0;

  const say = async (text: string) => {
    const { error } = await extension.rpc('upsert_segment', {
      p_token: TOKEN,
      p_session_id: sessionId,
      p_epoch: 0,
      p_seq: ++line,
      p_text: text,
      p_lang: 'en-US',
    });
    if (error) throw error;
  };

  beforeAll(async () => {
    const { data, error } = await extension.rpc('start_session', {
      p_token: TOKEN,
      p_title: 'TTS integration test',
      p_force: true,
      p_voice: 'male',
      p_tts: true,
    });
    if (error) throw error;
    sessionId = (data as { id: string }).id;
    const { pin } = data as { pin: string };
    for (const sb of [listener, stranger]) {
      const { error: authError } = await sb.auth.signInAnonymously();
      if (authError) throw authError;
    }
    const { error: joinError } = await listener.rpc('join_session', { p_pin: pin });
    if (joinError) throw joinError;
  });

  afterAll(async () => {
    await extension.rpc('end_session', { p_token: TOKEN, p_session_id: sessionId });
    await Promise.all([listener, stranger].map((sb) => sb.removeAllChannels()));
  });

  it('enables read-aloud once the first English line arrives', async () => {
    await say('Good morning, everyone.');
    const { data } = await listener
      .from('sessions')
      .select('tts_lang, tts_voice')
      .eq('id', sessionId);
    expect(data).toEqual([{ tts_lang: 'en', tts_voice: 'male' }]);
  });

  it('keeps strangers off the audio channel', async () => {
    const outsider = await listen(stranger, sessionId);
    expect(outsider.status).not.toBe('SUBSCRIBED');
    await outsider.close();
  });

  it('speaks a line one line behind, only to viewers who turned it on', async () => {
    const on = await listen(listener, sessionId);
    expect(on.status).toBe('SUBSCRIBED');
    expect((await listener.rpc('set_tts', { p_session_id: sessionId, p_on: true })).data).toBe(
      true,
    );

    await say('The first line to be read aloud.');
    // Line 1 was released when line 2 arrived (or by the pause flush), after TTS was turned on.
    const clip = await on.next();
    expect(clip).toMatchObject({
      session_id: sessionId,
      epoch: 0,
      part: 0,
      parts: 1,
      format: 'mp3_22050_32',
    });
    expect([1, 2]).toContain(clip.seq);
    expect(Buffer.from(clip.audio, 'base64').subarray(0, 3).toString('latin1')).toMatch(
      /^(ID3|\xff)/,
    );

    await say('And the next one.');
    const seqs = new Set([clip.seq, (await on.next()).seq]);
    expect(seqs.size).toBe(2);
    await on.close();
  });

  it('makes no clips when nobody listens', async () => {
    expect((await listener.rpc('set_tts', { p_session_id: sessionId, p_on: false })).data).toBe(
      true,
    );
    const watch = await listen(listener, sessionId);
    await say('Nobody hears this.');
    await say('Nor this.');
    await expect(watch.next(5000)).rejects.toThrow('no clip');
    await watch.close();
  });
});

describe('ElevenLabs balance for the extension (Edge Function tts-credits)', () => {
  const credits = (token: string) =>
    fetch(`${URL}/functions/v1/tts-credits`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

  it('reports the balance to the broadcaster', async () => {
    const res = await credits(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ used: 1234, limit: 10000, resets_at: 1894708800 });
  });

  it('refuses anyone without the broadcast token', async () => {
    expect((await credits('wrong')).status).toBe(401);
  });
});
