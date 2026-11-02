// A log recorded from the mock matches v2-session-1.json, and the mock's DOM matches the real page's.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../log-digest';
import { mountMock } from '../mock-abestar';
import { startRawLogger, type RawRecord } from '../raw-logger';
import { RECORDED_FROM as FROM, RECORDED_TO as TO, timelineFromLog } from '../timeline';
import realLog from '../logs/v2-session-1.json';

const log = realLog as RawRecord[];

function skeleton(root: Element): string[] {
  const path = (el: Element): string => {
    const id = el.getAttribute('data-testid');
    const here = id ? `${el.tagName}[${id}]` : el.tagName;
    return el.parentElement && el.parentElement !== root
      ? `${path(el.parentElement)}>${here}`
      : here;
  };
  return [...new Set(Array.from(root.querySelectorAll('*')).map(path))].sort();
}

describe('mock-abestar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    document.body.innerHTML = '<main></main>';
  });
  afterEach(() => vi.useRealTimers());

  it('replays the recorded lifecycle in the same order and timing', async () => {
    const steps = timelineFromLog(log, FROM, TO);
    const mock = mountMock(document.querySelector('main') as HTMLElement);
    const logger = startRawLogger(document.body);
    mock.play(steps);
    await vi.advanceTimersByTimeAsync(TO - FROM + 1000);

    const real = log.filter((r) => r.ev !== 'MARK' && r.t >= FROM && r.t < TO);
    const shapes = (records: RawRecord[]) => digest(records).map((s) => s.shape);
    expect(shapes(logger.records).sort()).toEqual(shapes(real).sort());
    expect(logger.records.filter((r) => r.st === 'corrected').map((r) => r.text)).toEqual(
      real.filter((r) => r.st === 'corrected').map((r) => r.text),
    );
  });

  it('has the same element structure as the real page', () => {
    const real = document.createElement('div');
    real.innerHTML = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../logs/v2-page-excerpt.html'),
      'utf8',
    );

    const main = document.querySelector('main') as HTMLElement;
    const mock = mountMock(main);
    mock.addLine({ seq: 1, status: 'corrected', text: 'One.', lang: 'en' });
    mock.setInterim('Tw');
    const feed = main.querySelector('[data-testid="subtitle-feed"]') as HTMLElement;
    feed.scrollTop = 0;
    (main.querySelector('button') as HTMLElement).hidden = false;

    const wrapper = document.createElement('div');
    wrapper.append((feed.parentElement as HTMLElement).cloneNode(true));
    expect(skeleton(wrapper)).toEqual(skeleton(real));
  });

  it('keeps the attributes capture reads', () => {
    const main = document.querySelector('main') as HTMLElement;
    const mock = mountMock(main);
    mock.addLine({ seq: 19, status: 'draft', text: 'One.', lang: 'en' });
    const line = main.querySelector('[data-testid="subtitle-line"]') as HTMLElement;
    expect(line.getAttribute('data-seg-id')).toMatch(/^[a-z0-9]+-19$/);
    expect(line.getAttribute('data-status')).toBe('draft');
    expect(line.getAttribute('lang')).toBe('en');
    mock.updateLine(19, 'corrected', 'One, final.');
    expect(line.getAttribute('data-status')).toBe('corrected');
    expect(line.textContent).toBe('One, final.');
  });
});
