// Returning Abestar's feed to the latest line. jsdom has no layout, so the feed's sizes are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountMock } from '../../fixtures/mock-abestar';
import { followLatest, type Follow } from '../src/content/follow';

let follow: Follow | undefined;
let height: number;

const feed = () => document.querySelector('[data-testid="subtitle-feed"]') as HTMLElement;
const button = () =>
  document.querySelector('[data-testid="subtitle-feed"] ~ button') as HTMLElement;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const stubSizes = (el: HTMLElement) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 100 });
};
const atBottom = () => {
  feed().scrollTop = height - 100;
};
const scrollBack = (top = 0) => {
  feed().scrollTop = top;
  feed().dispatchEvent(new Event('scroll'));
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  document.body.innerHTML = '<main></main>';
  mountMock(document.querySelector('main') as HTMLElement);
  height = 1000;
  stubSizes(feed());
  atBottom();
});

afterEach(() => {
  follow?.stop();
  follow = undefined;
  vi.useRealTimers();
});

describe('followLatest', () => {
  it('leaves a page at the bottom alone', async () => {
    const click = vi.spyOn(button(), 'click');
    follow = followLatest(document);
    await advance(20_000);
    expect(click).not.toHaveBeenCalled();
  });

  it('clicks the jump button 3 s after the page is scrolled back', async () => {
    const click = vi.spyOn(button(), 'click');
    follow = followLatest(document);
    scrollBack();
    await advance(2_400);
    expect(click).not.toHaveBeenCalled();
    await advance(1_100);
    expect(click).toHaveBeenCalledTimes(1);
    expect(feed().scrollTop).toBe(1000);
  });

  it('waits while the presenter keeps scrolling', async () => {
    const click = vi.spyOn(button(), 'click');
    follow = followLatest(document);
    for (const top of [400, 300, 200, 100, 0]) {
      scrollBack(top);
      await advance(2_000);
    }
    expect(click).not.toHaveBeenCalled();
    await advance(1_500);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('does not jump after the presenter returned to the bottom', async () => {
    const click = vi.spyOn(button(), 'click');
    follow = followLatest(document);
    scrollBack();
    await advance(1_000);
    atBottom();
    feed().dispatchEvent(new Event('scroll'));
    await advance(20_000);
    expect(click).not.toHaveBeenCalled();
  });

  it('catches up when the page falls behind with no scroll event, as a background tab may', async () => {
    const click = vi.spyOn(button(), 'click');
    follow = followLatest(document);
    await advance(10_000);
    height = 1800; // new lines arrived and nothing scrolled
    await advance(1_000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(feed().scrollTop).toBe(1800);
  });

  it('finds the button whatever its label says', async () => {
    button().textContent = '跳至最新';
    follow = followLatest(document);
    scrollBack();
    await advance(3_500);
    expect(feed().scrollTop).toBe(1000);
  });

  it('scrolls by itself when the button is not there', async () => {
    button().remove();
    follow = followLatest(document);
    scrollBack();
    await advance(3_500);
    expect(feed().scrollTop).toBe(1000);
  });

  it('copes with a feed that is not there yet, and one that was replaced', async () => {
    document.querySelector('main')?.replaceChildren();
    follow = followLatest(document);
    await advance(5_000);

    mountMock(document.querySelector('main') as HTMLElement);
    stubSizes(feed());
    scrollBack();
    await advance(3_500);
    expect(feed().scrollTop).toBe(1000);
  });

  it('stops when the broadcast ends', async () => {
    const click = vi.spyOn(button(), 'click');
    follow = followLatest(document);
    follow.stop();
    scrollBack();
    await advance(20_000);
    expect(click).not.toHaveBeenCalled();
    expect(feed().scrollTop).toBe(0);
  });
});
