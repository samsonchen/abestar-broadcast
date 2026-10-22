// The broadcaster RPCs of supabase/migrations/0001_init.sql, with errors mapped to what the worker acts on.

import { createClient } from '@supabase/supabase-js';
import type { ExtensionConfig } from '../config';

export type ApiError = 'invalid-token' | 'session-live' | 'session-not-live' | 'network';
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError; message: string };

export interface Api {
  startSession(
    token: string,
    title: string,
    force: boolean,
  ): Promise<ApiResult<{ id: string; pin: string }>>;
  upsertSegment(
    token: string,
    sessionId: string,
    epoch: number,
    seq: number,
    text: string,
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
    startSession: (token, title, force) =>
      call('start_session', { p_token: token, p_title: title, p_force: force }),
    upsertSegment: (token, sessionId, epoch, seq, text) =>
      call('upsert_segment', {
        p_token: token,
        p_session_id: sessionId,
        p_epoch: epoch,
        p_seq: seq,
        p_text: text,
      }),
    endSession: (token, sessionId) =>
      call('end_session', { p_token: token, p_session_id: sessionId }),
  };
}
