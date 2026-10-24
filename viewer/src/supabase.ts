// `Backend` over supabase-js: anonymous sign-in, join_session, reads under RLS, Postgres Changes, and the
// read-aloud channel and heartbeat (`TtsBackend`).
import type { Segment, Session, TtsClip } from '@abestar/shared';
import { createClient } from '@supabase/supabase-js';
import type { Backend, JoinResult } from './live';
import type { TtsBackend } from './tts';

export interface Config {
  supabaseUrl: string;
  publishableKey: string;
}

/** Supabase's default `max_rows`, which the hosted project keeps; a shorter page is the last one. */
const PAGE_ROWS = 1000;

/** The read-aloud languages a viewer can pick (e.g. `['en', 'zh']`); null when the database predates them. */
export interface TtsLanguages {
  ttsLanguages(): Promise<string[] | null>;
}

export function supabaseBackend(config: Config): Backend & TtsBackend & TtsLanguages {
  // The anonymous session is kept in localStorage, so a reload rejoins as the same viewer.
  const sb = createClient(config.supabaseUrl, config.publishableKey, {
    auth: { storageKey: 'abestar-viewer-auth', detectSessionInUrl: false },
  });

  async function signIn(fresh: boolean): Promise<boolean> {
    if (!fresh) {
      const { data } = await sb.auth.getSession();
      if (data.session) return true;
    } else {
      await sb.auth.signOut({ scope: 'local' });
    }
    const { error } = await sb.auth.signInAnonymously();
    return !error;
  }

  async function join(pin: string, fresh: boolean): Promise<JoinResult> {
    if (!(await signIn(fresh))) return { ok: false, error: 'network' };
    const { data, error } = await sb.rpc('join_session', { p_pin: pin });
    if (error) {
      // A stored anonymous user can be gone (deleted after 7 days); try once more as a new one.
      return fresh ? { ok: false, error: 'network' } : join(pin, true);
    }
    const result = data as { session?: Session; error?: string };
    if (result.session) return { ok: true, session: result.session };
    if (result.error === 'too_many_attempts') return { ok: false, error: 'too-many-attempts' };
    if (result.error === 'not_signed_in' && !fresh) return join(pin, true);
    return { ok: false, error: 'invalid-pin' };
  }

  /**
   * PostgREST returns at most `max_rows` (1000) rows per request, and a long talk has more lines, so this pages by
   * (epoch, seq) after the last row received. A row revised meanwhile is neither skipped nor repeated.
   */
  async function fetchSegments(sessionId: string, since: string | null): Promise<Segment[]> {
    const all: Segment[] = [];
    for (;;) {
      let page = sb
        .from('segments')
        .select('*')
        .eq('session_id', sessionId)
        .order('epoch')
        .order('seq')
        .limit(PAGE_ROWS);
      if (since) page = page.gte('updated_at', since);
      const last = all.at(-1);
      if (last) {
        page = page.or(`epoch.gt.${last.epoch},and(epoch.eq.${last.epoch},seq.gt.${last.seq})`);
      }
      const { data, error } = await page;
      if (error) throw error;
      all.push(...(data as Segment[]));
      if (data.length < PAGE_ROWS) return all;
    }
  }

  return {
    join: (pin) => join(pin, false),

    async fetch(sessionId, since) {
      const [s, segments] = await Promise.all([
        sb.from('sessions').select('*').eq('id', sessionId).maybeSingle(),
        fetchSegments(sessionId, since),
      ]);
      if (s.error) throw s.error;
      return { session: s.data as Session | null, segments };
    },

    subscribe(sessionId, on) {
      const channel = sb
        .channel(`viewer:${sessionId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'segments', filter: `session_id=eq.${sessionId}` },
          (p) => {
            if (p.eventType !== 'DELETE') on.segment(p.new as Segment);
          },
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
          (p) => on.session(p.new as Session),
        )
        // SUBSCRIBED arrives before Postgres Changes is attached; this system message confirms it.
        .on('system', {}, (m: { extension?: string; status?: string }) => {
          if (m.extension === 'postgres_changes' && m.status === 'ok') on.attached();
        })
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') on.lost();
        });
      return () => void sb.removeChannel(channel);
    },

    async ttsLanguages() {
      const { data, error } = await sb.rpc('tts_languages');
      return error || !Array.isArray(data) ? null : (data as string[]);
    },

    async setTts(sessionId, on, lang = null) {
      const { data, error } = await sb.rpc('set_tts', {
        p_session_id: sessionId,
        p_on: on,
        p_lang: lang,
      });
      if (error) throw error;
      return data === true;
    },

    listen(sessionId, onClip, onStatus = () => {}) {
      // Private: the server lets only joined viewers of a live session receive it.
      const channel = sb
        .channel(`tts:${sessionId}`, { config: { private: true } })
        .on('broadcast', { event: 'audio' }, ({ payload }) => onClip(payload as TtsClip))
        .subscribe((status, err) => onStatus(err ? `${status} ${err.message}` : status));
      return () => void sb.removeChannel(channel);
    },
  };
}
