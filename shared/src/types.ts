// Contract shared by the extension and the viewer (PLAN.md §7).

export type SessionStatus = 'live' | 'ended';

export interface Session {
  id: string;
  title: string;
  target_lang: string | null;
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
