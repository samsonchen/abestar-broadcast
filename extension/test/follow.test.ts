// Keeping Abestar's translation column at the newest line while the presenter is elsewhere, on the mock page.
// jsdom has no layout, so the column's scrollHeight is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountMock, type MockAbestar } from '../../fixtures/mock-abestar';
import { followBottom, type Follow } from '../src/content/follow';

let mock: MockAbestar;
let follow: Follow | undefined;
let focused: boolean;
let height: number;

const column = () => document.querySelector('[data-testid="col-right"]') as HTMLElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // MutationObserver callbacks

beforeEach(() => {
  document.body.innerHTML = '<main></main>';
  mock = mountMock(document.querySelector('main') as HTMLElement);
  focused = true;
  height = 500;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  Object.defineProperty(column(), 'scrollHeight', { configurable: true, get: () => height });
});

afterEach(() => {
  follow?.stop();
  follow = undefined;
  vi.restoreAllMocks();
});

describe('followBottom', () => {
  it('scrolls to the newest line when the broadcast starts', () => {
    follow = followBottom(document);
    expect(column().scrollTop).toBe(500);
  });

  it('follows new lines while the presenter is in another tab or window', async () => {
    follow = followBottom(document);
    focused = false;
    height = 800;
    mock.addPending();
    await flush();
    expect(column().scrollTop).toBe(800);

    height = 900;
    mock.resolve(1, 'A longer line that wraps.');
    await flush();
    expect(column().scrollTop).toBe(900);
  });

  it('leaves scrolling to Abestar while the presenter uses the Abestar tab', async () => {
    follow = followBottom(document);
    column().scrollTop = 100; // the presenter scrolled back to read
    height = 800;
    mock.addPending();
    await flush();
    expect(column().scrollTop).toBe(100);
  });

  it('catches up as soon as the presenter leaves the window', () => {
    follow = followBottom(document);
    column().scrollTop = 100;
    height = 800;
    window.dispatchEvent(new Event('blur'));
    expect(column().scrollTop).toBe(800);
  });

  it('stops following when the broadcast ends', async () => {
    follow = followBottom(document);
    follow.stop();
    focused = false;
    column().scrollTop = 100;
    height = 800;
    mock.addPending();
    window.dispatchEvent(new Event('blur'));
    await flush();
    expect(column().scrollTop).toBe(100);
  });
});
