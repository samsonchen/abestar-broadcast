// Settings shared by the Edge Functions `tts` and `tts-credits` (see supabase/functions/.env.example locally).

const env = (name: string) => Deno.env.get(name) ?? '';

export const ELEVENLABS_API_KEY = env('ELEVENLABS_API_KEY');
export const ELEVENLABS_BASE_URL = env('ELEVENLABS_BASE_URL') || 'https://api.elevenlabs.io';
export const TTS_FUNCTION_SECRET = env('TTS_FUNCTION_SECRET');
const SUPABASE_URL = env('SUPABASE_URL');
// The project's public key: the RPCs these functions call check a secret or the broadcast token, not a role.
// PUBLISHABLE_KEY is set by scripts/supabase-setup.sh --tts; the others are what Supabase provides to functions.
const API_PUBLIC_KEY =
  env('PUBLISHABLE_KEY') ||
  (JSON.parse(env('SUPABASE_PUBLISHABLE_KEYS') || '{}') as { default?: string }).default ||
  env('SUPABASE_ANON_KEY');

/** Calls a database RPC with the public key; returns the response for the caller to check. */
export function rpc(fn: string, args: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: API_PUBLIC_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}
