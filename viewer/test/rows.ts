import type { Segment, Session } from '@abestar/shared';

export const SESSION: Session = {
  id: 'session-1',
  title: 'Talk',
  target_lang: 'en-US',
  status: 'live',
  created_at: '2026-10-22T10:00:00.000000+00:00',
  last_activity_at: '2026-10-22T10:00:00.000000+00:00',
  ended_at: null,
};

/** A segment row; `at` is seconds after 10:00 for `updated_at`. */
export function row(epoch: number, seq: number, text: string, version = 1, at = seq): Segment {
  const time = `2026-10-22T10:00:${String(at).padStart(2, '0')}.000000+00:00`;
  return {
    session_id: SESSION.id,
    epoch,
    seq,
    text,
    prev_text: null,
    version,
    created_at: time,
    updated_at: time,
  };
}
