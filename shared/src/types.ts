// Contract shared by the extension and the viewer (PLAN.md §7).

export type SessionStatus = 'live' | 'ended';

/** Read-aloud voice, chosen by the broadcaster to match the speaker (docs/tts-plan.md D1). */
export type Voice = 'female' | 'male';

export interface Session {
  id: string;
  title: string;
  target_lang: string | null;
  /** The broadcaster's read-aloud switch; absent before migration 0002. */
  tts_on?: boolean;
  /** Language with an enabled voice (e.g. `en`) while read-aloud is on and available, else null. */
  tts_lang: string | null;
  tts_voice: Voice;
  status: SessionStatus;
  created_at: string;
  last_activity_at: string;
  ended_at: string | null;
}

export interface Segment {
  session_id: string;
  epoch: number;
  seq: number;
  text: string;
  /** Abestar's `lang` attribute of the card, e.g. `en-US`; null from extensions before 0.2.0. */
  lang: string | null;
  prev_text: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

// content script → background (the background worker stamps the epoch)
export type CaptureMessage =
  | { kind: 'segment'; seq: number; text: string; lang: string | null }
  | { kind: 'reset'; reason: 'load' | 'clear' }
  | { kind: 'status'; status: 'ok' | 'column-not-found' | 'detached' };

/** One read-aloud clip on the private Realtime channel `tts:<session_id>`, event `audio` (docs/tts-plan.md §6). */
export interface TtsClip {
  session_id: string;
  epoch: number;
  seq: number;
  /** Long lines are split; parts of a line play in order. */
  part: number;
  parts: number;
  lang: string | null;
  text_version: number;
  format: 'mp3_44100_64';
  /** Base64 MP3. */
  audio: string;
}
