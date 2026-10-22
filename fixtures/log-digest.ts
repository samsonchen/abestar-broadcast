// Reduces a raw mutation log to the behaviour that matters, so a log recorded from the mock
// can be compared with one recorded on the real page.

import type { RawRecord } from './raw-logger';

export type StepKind =
  | 'card-added' // placeholder card appended to the list
  | 'icon-added' // check icon inserted into the card: the translation has arrived
  | 'testid-removed' // dots testid stripped from the `<p>`
  | 'p-cleared' // dots text removed
  | 'typing-started'; // first characters appended

export interface Step {
  kind: StepKind;
  /** ms since the first record */
  t: number;
  /** owning card index, -1 for list-level changes */
  idx: number;
}

export interface Typing {
  idx: number;
  text: string;
  /** number of records that changed the text, including the first */
  frames: number;
  startT: number;
  endT: number;
}

export interface Digest {
  steps: Step[];
  /** times of placeholder dot updates */
  dotTicks: number[];
  typing: Typing[];
}

const DOTS = /^\.{1,3}$/;

export function digest(log: RawRecord[]): Digest {
  const t0 = log[0]?.t ?? 0;
  const out: Digest = { steps: [], dotTicks: [], typing: [] };

  for (const r of log) {
    const t = r.t - t0;
    const step = (kind: StepKind) => out.steps.push({ kind, t, idx: r.idx });

    if (r.type === 'characterData') {
      if (DOTS.test(r.text)) {
        out.dotTicks.push(t);
        continue;
      }
      // Typing text nodes have idx -1; attribute the frame to the card whose text it extends.
      const typing = out.typing.findLast((x) => r.text.startsWith(x.text));
      if (!typing) throw new Error(`unattributed text change at ${t} ms: ${r.text}`);
      typing.text = r.text;
      typing.frames++;
      typing.endT = t;
    } else if (r.type === 'attributes') {
      step('testid-removed');
    } else if (r.idx === -1) {
      step('card-added');
    } else if (r.html?.startsWith('<div')) {
      step('icon-added');
    } else if (r.text === '') {
      step('p-cleared');
    } else {
      step('typing-started');
      out.typing.push({ idx: r.idx, text: r.text, frames: 1, startT: t, endT: t });
    }
  }
  return out;
}
