// The broadcaster RPCs of supabase/migrations/0001_init.sql, with errors mapped to what the worker acts on.

import type { Voice } from '@abestar/shared';
import { createClient } from '@supabase/supabase-js';
import type { ExtensionConfig } from '../config';
import type { CreditsReply } from '../messages';

export type ApiError = 'invalid-token' | 'session-live' | 'session-not-live' | 'network';
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError; message: string };

export interface Api {
  startSession(
    token: string,
    title: string,
    force: boolean,
    tts: boolean,
    voice: Voice,
  ): Promise<ApiResult<{ id: string; pin: string }>>;
  upsertSegment(
    token: string,
    sessionId: string,
    epoch: number,
    seq: number,
    text: string,
    lang: string | null,
  ): Promise<ApiResult<null>>;
  setSessionTts(
    token: string,
    sessionId: string,
    on: boolean,
    voice: Voice,
  ): Promise<ApiResult<null>>;
  endSession(token: string, sessionId: string): Promise<ApiResult<null>>;
}

const BY_STATUS: Record<number, ApiError> = {
  401: 'invalid-token',
  409: 'session-live',
  410: 'session-not-live',
};

export function supabaseApi(config: ExtensionConfig): Api {
  const sb = createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function call<T>(fn: string, args: Record<string, unknown>): Promise<ApiResult<T>> {
    try {
      const { data, error, status } = await sb.rpc(fn, args);
      if (!error) return { ok: true, value: data as T };
      return { ok: false, error: BY_STATUS[status] ?? 'network', message: error.message };
    } catch (e) {
      return { ok: false, error: 'network', message: String(e) };
    }
  }

  return {
    startSession: (token, title, force, tts, voice) =>
      call('start_session', {
        p_token: token,
        p_title: title,
        p_force: force,
        p_tts: tts,
        p_voice: voice,
      }),
    upsertSegment: (token, sessionId, epoch, seq, text, lang) =>
      call('upsert_segment', {
        p_token: token,
        p_session_id: sessionId,
        p_epoch: epoch,
        p_seq: seq,
        p_text: text,
        p_lang: lang,
      }),
    setSessionTts: (token, sessionId, on, voice) =>
      call('set_session_tts', {
        p_token: token,
        p_session_id: sessionId,
        p_on: on,
        p_voice: voice,
      }),
    endSession: (token, sessionId) =>
      call('end_session', { p_token: token, p_session_id: sessionId }),
  };
}

/** The ElevenLabs balance, through the Edge Function `tts-credits` (the API key stays on Supabase). */
export async function fetchCredits(config: ExtensionConfig, token: string): Promise<CreditsReply> {
  try {
    const res = await fetch(`${config.supabaseUrl}/functions/v1/tts-credits`, {
      method: 'POST',
      headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const message = res.status === 401 ? 'invalid token' : (await res.text()).slice(0, 200);
      return { ok: false, missing: res.status === 404, message };
    }
    const { used, limit, resets_at } = (await res.json()) as {
      used: number;
      limit: number;
      resets_at: number | null;
    };
    return { ok: true, used, limit, resetsAt: resets_at };
  } catch (e) {
    return { ok: false, missing: false, message: String(e) };
  }
}
