// Pure parts of the Edge Function `tts` (docs/tts-plan.md §6), shared by Deno and the Vitest unit tests.

/** The body tts_enqueue posts (supabase/migrations/0002_tts.sql). */
export interface TtsJob {
  session_id: string;
  epoch: number;
  seq: number;
  text: string;
  previous_text: string | null;
  next_text: string | null;
  voice_id: string;
  model_id: string;
  language_code: string | null;
}

/** One ElevenLabs request; the neighbouring text only shapes intonation and is not spoken. */
export interface SpeechRequest {
  text: string;
  previous_text: string | null;
  next_text: string | null;
}

/**
 * About 25 s of speech: at 32 kbps a clip stays near 100 KB, about 135 KB in base64, well under Realtime's 256 KB
 * message limit.
 */
export const MAX_CHUNK = 400;

export function isJob(body: unknown): body is TtsJob {
  const b = body as Record<string, unknown> | null;
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  const optStr = (v: unknown) => v === null || v === undefined || typeof v === 'string';
  return (
    typeof b === 'object' &&
    b !== null &&
    str(b.session_id) &&
    Number.isInteger(b.epoch) &&
    Number.isInteger(b.seq) &&
    str(b.text) &&
    str(b.voice_id) &&
    str(b.model_id) &&
    optStr(b.previous_text) &&
    optStr(b.next_text) &&
    optStr(b.language_code)
  );
}

/** Splits text into chunks of at most `max` characters, at sentence ends, else at spaces, else anywhere. */
export function chunkText(text: string, max = MAX_CHUNK): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean ? [clean] : [];

  const pieces: string[] = [];
  for (const sentence of clean.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)/g) ?? [clean]) {
    let rest = sentence.trim();
    while (rest.length > max) {
      const space = rest.lastIndexOf(' ', max);
      const cut = space > 0 ? space : max;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }

  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= max)
      chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

/** The ElevenLabs requests for a line: one per chunk, each with its neighbours as context. */
export function speechRequests(job: TtsJob, max = MAX_CHUNK): SpeechRequest[] {
  const chunks = chunkText(job.text, max);
  return chunks.map((text, i) => ({
    text,
    previous_text: i > 0 ? (chunks[i - 1] as string) : (job.previous_text ?? null),
    next_text: i < chunks.length - 1 ? (chunks[i + 1] as string) : (job.next_text ?? null),
  }));
}

/** Body of POST /v1/text-to-speech/{voice_id}. */
export function elevenLabsBody(job: TtsJob, request: SpeechRequest): Record<string, unknown> {
  return {
    text: request.text,
    model_id: job.model_id,
    ...(job.language_code ? { language_code: job.language_code } : {}),
    ...(request.previous_text ? { previous_text: request.previous_text } : {}),
    ...(request.next_text ? { next_text: request.next_text } : {}),
  };
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
