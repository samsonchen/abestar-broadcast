// Capture driven by the mock, whose fidelity to the real page is checked by fixtures/test/mock-fidelity.test.ts.
import type { CaptureMessage } from '@abestar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountMock, type MockAbestar, type MockOptions } from '../../fixtures/mock-abestar';
import { RECORDED_FROM, RECORDED_TO, timelineFromLog } from '../../fixtures/timeline';
import type { RawRecord } from '../../fixtures/raw-logger';
import log from '../../fixtures/logs/v2-session-1.json';
import { startCapture, type Capture, type CaptureOptions } from '../src/content/capture';

let sent: CaptureMessage[];
let capture: Capture | undefined;

const segments = () => sent.filter((m) => m.kind === 'segment');
const baselines = () => sent.flatMap((m) => (m.kind === 'baseline' ? [m.seq] : []));
const statuses = () => sent.flatMap((m) => (m.kind === 'status' ? [m.status] : []));
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const corrected = (seq: number, text = `Line ${seq}.`) => ({
  seq,
  status: 'corrected',
  text,
  lang: 'en',
});
const draft = (seq: number, text = `Draft ${seq}.`) => ({ seq, status: 'draft', text, lang: 'en' });

async function page(options: MockOptions = {}): Promise<MockAbestar> {
  const mock = mountMock(document.querySelector('main') as HTMLElement, options);
  await advance(100); // the history batch
  return mock;
}
const start = (options?: CaptureOptions) => {
  capture = startCapture(document, (m) => sent.push(m), options);
};
/** Capture on an empty feed, past the window in which the first batch of lines counts as history. */
const startSettled = async () => {
  start();
  await advance(5_000);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  document.body.innerHTML = '<main></main>';
  sent = [];
});

afterEach(() => {
  capture?.stop();
  capture = undefined;
  vi.useRealTimers();
});

describe('final lines', () => {
  it('sends a line once, with its corrected text, and never interim or draft text', async () => {
    const mock = await page();
    start();
    mock.setInterim('Interim text');
    await advance(500);
    mock.setInterim(null);
    mock.addLine(draft(1, 'Draft text'));
    await advance(1500);
    expect(segments()).toEqual([]);

    mock.updateLine(1, 'corrected', 'Final text');
    await advance(0);
    expect(segments()).toEqual([{ kind: 'segment', seq: 1, text: 'Final text', lang: 'en' }]);

    await advance(20_000);
    expect(segments()).toHaveLength(1);
  });

  it('sends a line that is added already corrected', async () => {
    const mock = await page();
    await startSettled();
    mock.addLine(corrected(1));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([1]);
  });

  it('turns the recorded session into one send per line, with the final text', async () => {
    const steps = timelineFromLog(log as RawRecord[], RECORDED_FROM, RECORDED_TO);
    const mock = await page();
    await startSettled();
    mock.play(steps);
    await advance(RECORDED_TO - RECORDED_FROM + 1000);

    const real = (log as RawRecord[]).filter(
      (r) =>
        r.t >= RECORDED_FROM && r.t < RECORDED_TO && r.st === 'corrected' && r.id !== 'interim',
    );
    expect(segments().map((m) => m.text)).toEqual(real.map((r) => r.text));
    const seqs = segments().map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('keeps each line in its own language across a language switch', async () => {
    const mock = await page();
    await startSettled();
    mock.addLine(corrected(1));
    await advance(0);
    mock.addLine({ seq: 2, status: 'corrected', text: 'こんにちは', lang: 'ja' });
    await advance(0);
    expect(segments().map((m) => m.kind === 'segment' && m.lang)).toEqual(['en', 'ja']);
  });

  it('skips a corrected line whose text has not arrived, and sends it when it does', async () => {
    const mock = await page();
    await startSettled();
    mock.addLine({ seq: 1, status: 'corrected', text: '', lang: 'en' });
    await advance(0);
    expect(segments()).toEqual([]);
    mock.updateLine(1, 'corrected', 'Now it has text.');
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([1]);
  });
});

describe('a line stuck in draft', () => {
  it('is sent after 10 s, and updated once if it is corrected later', async () => {
    const mock = await page();
    start();
    mock.addLine(draft(1, 'Stuck text'));
    await advance(9_999);
    expect(segments()).toEqual([]);
    await advance(1);
    expect(segments()).toEqual([{ kind: 'segment', seq: 1, text: 'Stuck text', lang: 'en' }]);

    mock.updateLine(1, 'corrected', 'Late correction');
    await advance(0);
    expect(segments().map((m) => m.kind === 'segment' && m.text)).toEqual([
      'Stuck text',
      'Late correction',
    ]);
    await advance(20_000);
    expect(segments()).toHaveLength(2);
  });

  it('is not sent early by text changes while a draft', async () => {
    const mock = await page();
    start();
    mock.addLine(draft(1, 'One'));
    await advance(5_000);
    mock.updateLine(1, 'draft', 'One more');
    await advance(5_000);
    expect(segments().map((m) => m.kind === 'segment' && m.text)).toEqual(['One more']);
  });

  it('treats an unknown status like a draft', async () => {
    const mock = await page();
    start();
    mock.addLine({ seq: 1, status: 'reviewing', text: 'Unknown', lang: 'en' });
    await advance(0);
    expect(segments()).toEqual([]);
    await advance(10_000);
    expect(segments().map((m) => m.seq)).toEqual([1]);
  });

  it('is cancelled by stop', async () => {
    const mock = await page();
    start();
    mock.addLine(draft(1));
    await advance(0);
    capture?.stop();
    await advance(20_000);
    expect(segments()).toEqual([]);
  });
});

describe('baseline', () => {
  it('does not send what is on screen when the broadcast starts, and reports it', async () => {
    const mock = await page({ history: [corrected(1), corrected(2)] });
    start();
    await advance(0);
    expect(baselines()).toEqual([2]);
    mock.addLine(corrected(3));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([3]);
  });

  it('still sends a draft that was on screen when the broadcast started', async () => {
    const mock = await page({ history: [corrected(1), draft(2)] });
    start();
    await advance(0);
    expect(baselines()).toEqual([1]);
    mock.updateLine(2, 'corrected', 'Two.');
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([2]);
  });

  it('counts history that arrives just after an empty feed appears', async () => {
    mountMock(document.querySelector('main') as HTMLElement, {
      history: [corrected(1), corrected(2)],
    });
    start(); // before the history batch, as when the feed has just appeared
    await advance(100);
    expect(baselines()).toEqual([2]);
    expect(segments()).toEqual([]);
  });

  it('counts history when the broadcast starts on the language picker', async () => {
    const mock = mountMock(document.querySelector('main') as HTMLElement, {
      picker: true,
      history: [corrected(1), corrected(2)],
    });
    start();
    await advance(60_000); // the presenter takes their time to choose a language
    expect(statuses()).toContain('column-not-found');
    mock.enter();
    await advance(100);
    expect(statuses().at(-1)).toBe('ok');
    expect(baselines()).toEqual([2]);
    expect(segments()).toEqual([]);

    mock.addLine(corrected(3));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([3]);
  });

  it('starts from 0 on an event with no history', async () => {
    const mock = await page();
    start();
    await advance(5_000);
    expect(baselines()).toEqual([0]);
    mock.addLine(corrected(1));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([1]);
  });
});

describe('history that comes late or out of order', () => {
  it('does not send history that arrives after a new draft on an empty feed', async () => {
    const mock = await page();
    start();
    mock.addLine(draft(61));
    await advance(0);
    expect(baselines()).toEqual([60]);

    mock.addLine(corrected(59));
    mock.addLine(corrected(60));
    await advance(0);
    expect(segments()).toEqual([]);

    mock.updateLine(61, 'corrected', 'Sixty-one.');
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([61]);
  });

  it('starts from 0 when the first draft is the first line of the event', async () => {
    const mock = await page();
    start();
    mock.addLine(draft(1));
    await advance(0);
    expect(baselines()).toEqual([0]);
    mock.updateLine(1, 'corrected', 'One.');
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([1]);
  });

  it('counts a batch that arrives after the history window as history', async () => {
    const mock = await page();
    start();
    await advance(5_000);
    expect(baselines()).toEqual([0]);

    for (const seq of [1, 2, 3]) mock.addLine(corrected(seq));
    await advance(0);
    expect(baselines()).toEqual([0, 3]);
    expect(segments()).toEqual([]);

    mock.addLine(corrected(4));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([4]);
  });

  it('sends one final line that arrives after the history window', async () => {
    const mock = await page();
    start();
    await advance(5_000);
    mock.addLine(corrected(1));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([1]);
  });

  it('treats a late batch as history after a reload that found no lines yet', async () => {
    const mock = await page();
    start({ resumeAfterSeq: 0 });
    for (const seq of [1, 2]) mock.addLine(corrected(seq));
    await advance(0);
    expect(segments()).toEqual([]);
  });
});

describe('moving to another event in the same tab', () => {
  const at = (path: string) => history.replaceState(null, '', path);
  const events = () => sent.flatMap((m) => (m.kind === 'event' ? [m.code] : []));

  afterEach(() => at('/'));

  it('reports the event it starts on', async () => {
    at('/listen/AAA-1');
    await page();
    start();
    await advance(0);
    expect(events()).toEqual(['AAA-1']);
  });

  it('does not count /j/ moving to /listen/ for the same event as a move', async () => {
    at('/j/AAA-1');
    const mock = await page({ history: [corrected(1)] });
    start();
    at('/listen/AAA-1');
    mock.addLine(corrected(2));
    await advance(0);
    expect(events()).toEqual(['AAA-1']);
    expect(segments().map((m) => m.seq)).toEqual([2]);
  });

  it('starts over on the new event: its low numbers are sent, its history is not', async () => {
    at('/listen/AAA-1');
    const old = await page({ history: [corrected(300)] });
    start();
    old.addLine(corrected(301));
    await advance(0);

    at('/listen/BBB-2');
    old.addLine(corrected(302)); // the old feed, still on screen for a moment
    await advance(0);
    expect(events()).toEqual(['AAA-1', 'BBB-2']);
    expect(segments().map((m) => m.seq)).toEqual([301]);

    const next = mountMock(document.querySelector('main') as HTMLElement, {
      history: [corrected(1), corrected(2)],
    });
    await advance(100);
    expect(baselines().at(-1)).toBe(2);
    expect(segments().map((m) => m.seq)).toEqual([301]);

    next.addLine(corrected(3));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([301, 3]);
  });
});

describe('recovering', () => {
  it('sends the lines missed during a reload, and reports no new baseline', async () => {
    const history = [corrected(1), corrected(2), corrected(3), corrected(4)];
    mountMock(document.querySelector('main') as HTMLElement, { history });
    start({ resumeAfterSeq: 2 });
    await advance(100);
    expect(segments().map((m) => m.seq)).toEqual([3, 4]);
    expect(baselines()).toEqual([]);
  });

  it('sends lines that arrive in a batch after a dropped connection', async () => {
    const mock = await page({ history: [corrected(1)] });
    start();
    await advance(0);
    for (const seq of [2, 3, 4, 5]) mock.addLine(corrected(seq));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([2, 3, 4, 5]);
  });

  it('does not send lines again when React remounts the feed', async () => {
    const mock = await page({ history: [corrected(1)] });
    start();
    mock.addLine(corrected(2));
    await advance(0);
    mock.remountFeed();
    await advance(100);
    expect(segments().map((m) => m.seq)).toEqual([2]);

    mock.addLine(corrected(3));
    await advance(0);
    expect(segments().map((m) => m.seq)).toEqual([2, 3]);
    expect(statuses()).toEqual(['ok', 'detached', 'ok']);
  });

  it('sends nothing after stop', async () => {
    const mock = await page();
    start();
    await advance(5_000);
    capture?.stop();
    mock.addLine(corrected(1));
    await advance(0);
    expect(segments()).toEqual([]);
  });
});
