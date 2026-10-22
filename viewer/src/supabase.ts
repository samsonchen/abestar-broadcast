// `Backend` over supabase-js: anonymous sign-in, join_session, reads under RLS, Postgres Changes.
import type { Segment, Session } from '@abestar/shared';
import { createClient } from '@supabase/supabase-js';
import type { Backend, JoinResult } from './live';

export interface Config {
  supabaseUrl: string;
  publishableKey: string;
}

export function supabaseBackend(config: Config): Backend {
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

  return {
    join: (pin) => join(pin, false),

    async fetch(sessionId, since) {
      let segments = sb
        .from('segments')
        .select('*')
        .eq('session_id', sessionId)
        .order('epoch')
        .order('seq');
      if (since) segments = segments.gte('updated_at', since);
      const [s, g] = await Promise.all([
        sb.from('sessions').select('*').eq('id', sessionId).maybeSingle(),
        segments,
      ]);
      if (s.error) throw s.error;
      if (g.error) throw g.error;
      return { session: s.data as Session | null, segments: g.data as Segment[] };
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
  };
}
