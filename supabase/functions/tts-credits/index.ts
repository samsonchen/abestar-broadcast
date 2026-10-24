// Edge Function `tts-credits`: the ElevenLabs balance for the extension's popup, so the API key stays here.
// The caller proves it is the broadcaster with the broadcast token (checked by the database). The numbers are the
// account's (GET /v1/user/subscription, which needs the key's "User" permission), not the key's own credit quota.
import { ELEVENLABS_API_KEY, ELEVENLABS_BASE_URL, rpc } from '../_shared/env.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token : '';

  const check = await rpc('check_broadcast_token', { p_token: token });
  if (check.status === 401) return new Response('invalid token', { status: 401 });
  if (!check.ok) return new Response(`token check: HTTP ${check.status}`, { status: 502 });

  if (!ELEVENLABS_API_KEY) return new Response('ELEVENLABS_API_KEY is not set', { status: 502 });
  const res = await fetch(`${ELEVENLABS_BASE_URL}/v1/user/subscription`, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    return new Response(`ElevenLabs HTTP ${res.status}: ${detail}`, { status: 502 });
  }
  const sub = (await res.json()) as {
    character_count?: number;
    character_limit?: number;
    next_character_count_reset_unix?: number | null;
  };
  return Response.json({
    used: sub.character_count ?? 0,
    limit: sub.character_limit ?? 0,
    resets_at: sub.next_character_count_reset_unix ?? null,
  });
});
