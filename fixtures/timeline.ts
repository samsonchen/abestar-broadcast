// Turns a recorded log into steps the mock can replay.
import type { RawRecord } from './raw-logger';

export type TimelineStep =
  | { at: number; action: 'interim'; text: string | null }
  | { at: number; action: 'add'; seq: number; status: string; text: string; lang: string }
  | { at: number; action: 'update'; seq: number; status: string; text: string };

/** A window of v2-session-1.json that starts with no interim and no draft on screen and ends before the recording
 * scrolled back, went offline and switched language. Replaying from mid-line would update lines the mock never saw. */
export const RECORDED_FROM = 7_920;
export const RECORDED_TO = 170_000;

const seqOf = (id: string) => Number(id.split('-').at(-1));

export function timelineFromLog(log: RawRecord[], fromMs: number, toMs: number): TimelineStep[] {
  const steps: TimelineStep[] = [];
  for (const r of log) {
    if (r.ev === 'MARK' || r.t < fromMs || r.t >= toMs || !r.id) continue;
    const at = r.t - fromMs;
    if (r.id === 'interim') {
      steps.push({ at, action: 'interim', text: r.ev === 'gone' ? null : (r.text ?? '') });
    } else if (r.ev === 'add') {
      steps.push({
        at,
        action: 'add',
        seq: seqOf(r.id),
        status: r.st ?? 'draft',
        text: r.text ?? '',
        lang: r.lang ?? 'en',
      });
    } else if (r.ev === 'change') {
      steps.push({
        at,
        action: 'update',
        seq: seqOf(r.id),
        status: r.st ?? 'draft',
        text: r.text ?? '',
      });
    }
  }
  return steps;
}
