// Edge Function `tts` (docs/tts-plan.md §6): one line → ElevenLabs → clips handed to tts_deliver, which pushes
// them to the listeners. Only the database calls it (pg_net, with the shared secret). Logic lives in lib.ts.
import {
  ELEVENLABS_API_KEY,
  ELEVENLABS_BASE_URL,
  rpc as callRpc,
  TTS_FUNCTION_SECRET,
} from '../_shared/env.ts';
import {
  base64,
  elevenLabsBody,
  isJob,
  speechRequests,
  type SpeechRequest,
  type TtsJob,
} from './lib.ts';

const SECRET = TTS_FUNCTION_SECRET;
const FORMAT = 'mp3_22050_32';

async function rpc(fn: 'tts_deliver' | 'tts_fail', args: Record<string, unknown>): Promise<void> {
  const res = await callRpc(fn, { p_secret: SECRET, ...args });
  if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${await res.text()}`);
}

// Stored settings per voice, kept while this instance lives; a voice's settings rarely change.
const storedSettings = new Map<string, Record<string, unknown>>();

/** The voice's stored settings, needed only when a speed is sent; {} (ElevenLabs' defaults) if they can't be read. */
async function voiceSettings(job: TtsJob): Promise<Record<string, unknown>> {
  if (typeof job.speed !== 'number') return {};
  const cached = storedSettings.get(job.voice_id);
  if (cached) return cached;
  const url = `${ELEVENLABS_BASE_URL}/v1/voices/${encodeURIComponent(job.voice_id)}/settings`;
  const res = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });
  if (!res.ok) {
    console.error(
      `voice settings ${job.voice_id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
    return {};
  }
  const settings = (await res.json()) as Record<string, unknown>;
  storedSettings.set(job.voice_id, settings);
  return settings;
}

async function synthesize(
  job: TtsJob,
  request: SpeechRequest,
  settings: Record<string, unknown>,
): Promise<Uint8Array> {
  const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(job.voice_id)}?output_format=${FORMAT}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(elevenLabsBody(job, request, settings)),
  });
  if (!res.ok)
    throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return new Uint8Array(await res.arrayBuffer());
}

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get('x-tts-secret') !== SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  const job: unknown = await req.json().catch(() => null);
  if (!isJob(job)) return new Response('bad request', { status: 400 });

  const key = { p_session_id: job.session_id, p_epoch: job.epoch, p_seq: job.seq };
  try {
    if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set');
    const requests = speechRequests(job);
    const settings = await voiceSettings(job);
    for (const [part, request] of requests.entries()) {
      const audio = await synthesize(job, request, settings);
      await rpc('tts_deliver', {
        ...key,
        p_part: part,
        p_parts: requests.length,
        p_audio: base64(audio),
        p_chars: request.text.length,
      });
    }
    return new Response('ok');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`tts ${job.session_id} ${job.epoch}:${job.seq}: ${message}`);
    await rpc('tts_fail', { ...key, p_error: message }).catch((err) => console.error(String(err)));
    return new Response(message, { status: 502 });
  }
});
