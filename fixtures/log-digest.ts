// Reduces a log to what capture depends on, so a log recorded from the mock can be compared with a real one.
import type { RawRecord } from './raw-logger';

export interface Step {
  /** e.g. `add:mvy16ds3-37:draft`, `change:mvy16ds3-37:corrected`, `gone:interim`. */
  shape: string;
  /** ms since the first record */
  t: number;
  text?: string;
}

/** Line records (no MARKs), in order within one observer callback, which may differ between page and mock. */
export function digest(log: RawRecord[]): Step[] {
  const lines = log.filter((r) => r.ev !== 'MARK');
  const t0 = lines[0]?.t ?? 0;
  return lines
    .map((r) => {
      const step: Step = {
        shape: [r.ev, r.id, r.st].filter((x) => x != null).join(':'),
        t: r.t - t0,
      };
      if (r.text !== undefined) step.text = r.text;
      return step;
    })
    .sort((a, b) => a.t - b.t || a.shape.localeCompare(b.shape));
}
