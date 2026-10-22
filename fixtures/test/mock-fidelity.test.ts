// M0 acceptance: a mutation log recorded from the mock matches raw-session-1.json
// in sequence and approximate timing (PLAN.md §8).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest, type Digest } from '../log-digest';
import { mountMock, SESSION_1 } from '../mock-abestar';
import { startRawLogger, type RawRecord } from '../raw-logger';
import realLog from '../logs/raw-session-1.json';

const STEP_TOLERANCE_MS = 50;
const TYPING_TOLERANCE = 0.25;

function recordMockSession(): RawRecord[] {
  document.body.innerHTML = '<main></main>';
  const mock = mountMock(document.querySelector('main') as HTMLElement);
  const logger = startRawLogger(document.querySelector('[data-testid="col-right"]') as Element);
  mock.play(SESSION_1);
  return logger.records;
}

describe('mock-abestar vs raw-session-1.json', () => {
  let real: Digest;
  let mock: Digest;

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    const records = recordMockSession();
    // Async advance flushes the MutationObserver microtask after every timer.
    await vi.advanceTimersByTimeAsync(22_000);
    real = digest(realLog as RawRecord[]);
    mock = digest(records);
  });

  afterEach(() => vi.useRealTimers());

  it('produces the same structural steps in the same order', () => {
    const shape = (d: Digest) => d.steps.map((s) => `${s.kind}#${s.idx}`);
    expect(shape(mock)).toEqual(shape(real));
  });

  it('times the structural steps within tolerance', () => {
    mock.steps.forEach((s, i) => {
      expect(Math.abs(s.t - (real.steps[i]?.t ?? NaN))).toBeLessThanOrEqual(STEP_TOLERANCE_MS);
    });
  });

  it('types the same final texts at a similar speed', () => {
    expect(mock.typing.map((x) => [x.idx, x.text])).toEqual(
      real.typing.map((x) => [x.idx, x.text]),
    );
    mock.typing.forEach((x, i) => {
      const r = real.typing[i] as (typeof real.typing)[number];
      expect(Math.abs(x.frames - r.frames) / r.frames).toBeLessThanOrEqual(TYPING_TOLERANCE);
      const [dur, realDur] = [x.endT - x.startT, r.endT - r.startT];
      expect(Math.abs(dur - realDur) / realDur).toBeLessThanOrEqual(TYPING_TOLERANCE);
    });
  });

  it('cycles placeholder dots at the same rate', () => {
    expect(Math.abs(mock.dotTicks.length - real.dotTicks.length)).toBeLessThanOrEqual(3);
  });

  it('settles on the four expected sentences', () => {
    expect(mock.typing.map((x) => x.text)).toEqual([
      'Chinese test, testing translation.',
      'Come and check out the Furry Kid Market.',
      'Healthy and flexible for brisk walking, or enhanced maintenance for joint degeneration warnings.',
      'Pet joint health self-assessment form.',
    ]);
  });
});
