// M2 acceptance (PLAN.md §4.6, §8): capture driven by the mock, whose fidelity to the real page is
// checked by fixtures/test/mock-fidelity.test.ts.
import type { CaptureMessage } from '@abestar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountMock, SESSION_1, type MockAbestar } from '../../fixtures/mock-abestar';
import settled from '../../fixtures/logs/settled-events.json';
import { startCapture, type Capture, type CaptureOptions } from '../src/content/capture';

const SESSION_1_TEXTS = [
  'Chinese test, testing translation.',
  'Come and check out the Furry Kid Market.',
  'Healthy and flexible for brisk walking, or enhanced maintenance for joint degeneration warnings.',
  'Pet joint health self-assessment form.',
];

let sent: CaptureMessage[];
let capture: Capture | undefined;

const segments = () => sent.filter((m) => m.kind === 'segment');
const resets = () => sent.filter((m) => m.kind === 'reset');
const statuses = () => sent.flatMap((m) => (m.kind === 'status' ? [m.status] : []));
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const column = () => document.querySelector('[data-testid="col-right"]') as HTMLElement;

function mount(): MockAbestar {
  return mountMock(document.querySelector('main') as HTMLElement);
}

function capture_(options?: CaptureOptions) {
  capture = startCapture(document, (m) => sent.push(m), options);
}

/** Resolves a new card with `text` and lets it settle. */
async function say(mock: MockAbestar, text: string) {
  const n = mock.addPending();
  await advance(1000);
  mock.resolve(n, text);
  await advance(2000);
  return n;
}

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

describe('capture', () => {
  it('turns the recorded session into exactly one event per card', async () => {
    const mock = mount();
    capture_();
    mock.play(SESSION_1);
    await advance(23_000);

    expect(segments()).toEqual(
      SESSION_1_TEXTS.map((text, i) => ({ kind: 'segment', seq: i + 1, text, lang: 'en-US' })),
    );
    expect(resets()).toEqual([{ kind: 'reset', reason: 'load' }]);
    expect(statuses()).toEqual(['ok']);
  });

  it('never sends placeholder dots', async () => {
    const mock = mount();
    capture_();
    mock.addPending();
    await advance(10_000);
    expect(segments()).toEqual([]);
  });

  it('sends a second event when a settled card changes', async () => {
    const mock = mount();
    capture_();
    const n = await say(mock, 'Chen Shih-chung is practically about to overtake him.');
    const p = column().querySelector(`[data-testid="translation-${n}"] p`) as HTMLElement;
    p.textContent = 'Chiang Wan-an is practically about to overtake him.';
    await advance(1000);

    expect(segments().map((m) => m.text)).toEqual([
      'Chen Shih-chung is practically about to overtake him.',
      'Chiang Wan-an is practically about to overtake him.',
    ]);
    expect(new Set(segments().map((m) => m.seq))).toEqual(new Set([n]));
  });

  it('ignores mutations that leave the text unchanged', async () => {
    const mock = mount();
    capture_();
    const n = await say(mock, 'Same text.');
    const card = column().querySelector(`[data-testid="translation-${n}"]`) as HTMLElement;
    card.className += ' highlighted';
    await advance(1000);
    expect(segments()).toHaveLength(1);
  });

  it('starts a new epoch when the broom clears the column, and resends numbers from 1', async () => {
    const mock = mount();
    capture_();
    for (const event of settled.slice(0, 2)) await say(mock, event.text);
    mock.clear();
    await advance(10);
    await say(mock, (settled[2] as (typeof settled)[number]).text);

    expect(resets().map((m) => m.reason)).toEqual(['load', 'clear']);
    expect(segments().map((m) => m.seq)).toEqual([1, 2, 1]);
  });

  it('detects a restart even when the clear and the new card land in one render', async () => {
    const mock = mount();
    capture_();
    await say(mock, 'First talk, line one.');
    await say(mock, 'First talk, line two.');
    const list = column().firstElementChild as HTMLElement;
    const fresh = list
      .querySelector('[data-testid="translation-1"]')
      ?.cloneNode(true) as HTMLElement;
    (fresh.querySelector('p') as HTMLElement).textContent = 'Second talk, line one.';
    for (const card of Array.from(list.querySelectorAll('[data-testid^="translation-"]')))
      card.remove();
    list.prepend(fresh);
    await advance(1000);

    expect(resets().map((m) => m.reason)).toEqual(['load', 'clear']);
    expect(segments().at(-1)).toMatchObject({ seq: 1, text: 'Second talk, line one.' });
  });

  it('does not reset when old cards are dropped but numbering continues', async () => {
    const mock = mount();
    capture_();
    await say(mock, 'Line one.');
    await say(mock, 'Line two.');
    column().querySelector('[data-testid="translation-1"]')?.remove();
    await say(mock, 'Line three.');

    expect(resets()).toHaveLength(1);
    expect(segments().map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('does not reset when all old cards are replaced by higher numbers in one render', async () => {
    const mock = mount();
    capture_();
    await say(mock, 'Line one.');
    const list = column().firstElementChild as HTMLElement;
    const next = list
      .querySelector('[data-testid="translation-1"]')
      ?.cloneNode(true) as HTMLElement;
    next.setAttribute('data-testid', 'translation-2');
    (next.querySelector('p') as HTMLElement).textContent = 'Line two.';
    list.querySelector('[data-testid="translation-1"]')?.remove();
    list.prepend(next);
    await advance(1000);

    expect(resets()).toHaveLength(1);
    expect(segments().map((m) => m.seq)).toEqual([1, 2]);
  });

  it('re-attaches after React remounts the column, without resending or resetting', async () => {
    const mock = mount();
    capture_();
    await say(mock, 'Before the remount.');

    const old = column();
    const remounted = old.cloneNode(true) as HTMLElement;
    old.replaceWith(remounted);
    await advance(1000);

    const card = remounted
      .querySelector('[data-testid="translation-1"]')
      ?.cloneNode(true) as HTMLElement;
    card.setAttribute('data-testid', 'translation-2');
    (card.querySelector('p') as HTMLElement).textContent = 'After the remount.';
    remounted.firstElementChild?.prepend(card);
    await advance(1000);

    expect(statuses()).toEqual(['ok', 'detached', 'ok']);
    expect(resets()).toHaveLength(1);
    expect(segments().map((m) => m.text)).toEqual(['Before the remount.', 'After the remount.']);
  });

  it('treats a remounted column showing only unseen text as a restart', async () => {
    const mock = mount();
    capture_();
    await say(mock, 'Old talk.');

    const remounted = column().cloneNode(true) as HTMLElement;
    (remounted.querySelector('[data-testid="translation-1"] p') as HTMLElement).textContent =
      'New talk.';
    column().replaceWith(remounted);
    await advance(1000);

    expect(resets().map((m) => m.reason)).toEqual(['load', 'clear']);
    expect(segments().at(-1)).toMatchObject({ seq: 1, text: 'New talk.' });
  });

  it('reports a missing column after the timeout, then recovers', async () => {
    capture_({ columnTimeoutMs: 10_000 });
    await advance(9_000);
    expect(statuses()).toEqual([]);
    await advance(2_000);
    expect(statuses()).toEqual(['column-not-found']);

    const mock = mount();
    await advance(10);
    await say(mock, 'Late column.');
    expect(statuses()).toEqual(['column-not-found', 'ok']);
    expect(segments()).toHaveLength(1);
  });

  describe('starting mid-talk', () => {
    async function talkInProgress() {
      const mock = mount();
      await advance(10);
      mock.addPending();
      mock.addPending();
      await advance(500);
      mock.resolve(1, 'Already on screen.');
      await advance(2000);
      return mock;
    }

    it('skips what is already on screen by default', async () => {
      const mock = await talkInProgress();
      capture_();
      mock.resolve(2, 'Arrives after start.');
      await advance(2000);
      expect(segments().map((m) => m.text)).toEqual(['Arrives after start.']);
    });

    it('backfills it when asked to include existing text', async () => {
      const mock = await talkInProgress();
      capture_({ includeExisting: true });
      mock.resolve(2, 'Arrives after start.');
      await advance(2000);
      expect(segments().map((m) => m.text)).toEqual(['Already on screen.', 'Arrives after start.']);
    });
  });

  it('sends nothing after stop', async () => {
    const mock = mount();
    capture_();
    const n = mock.addPending();
    capture?.stop();
    mock.resolve(n, 'Too late.');
    await advance(2000);
    expect(segments()).toEqual([]);
  });
});
