// Keeps Abestar's feed at the latest line while the broadcast runs: a page left scrolled back, by accident or not,
// returns 3 s after the last scroll. Capture does not depend on this; it is for whoever watches the page.

import { FEED, JUMP_BUTTON } from './selectors';

export interface Follow {
  stop(): void;
}

export interface FollowOptions {
  /** How long after the last scroll to return. */
  idleMs?: number;
  /** How often to check. A timer, because a page that falls behind in a background tab fires no scroll event. */
  checkMs?: number;
}

const BOTTOM_SLOP_PX = 2;

export function followLatest(
  doc: Document,
  { idleMs = 3_000, checkMs = 500 }: FollowOptions = {},
): Follow {
  let lastScroll = Date.now();

  // Scroll events do not bubble; the capture phase also covers a feed React has replaced.
  const onScroll = (event: Event) => {
    if (event.target instanceof Element && event.target.matches(FEED)) lastScroll = Date.now();
  };
  doc.addEventListener('scroll', onScroll, true);

  const check = setInterval(() => {
    const feed = doc.querySelector(FEED);
    if (!feed) return;
    const behind = feed.scrollHeight - feed.scrollTop - feed.clientHeight > BOTTOM_SLOP_PX;
    if (!behind || Date.now() - lastScroll < idleMs) return;
    const button = doc.querySelector<HTMLElement>(JUMP_BUTTON);
    // The mock and the real page both remove or hide it when not needed; a click on a hidden one is harmless.
    button?.click();
    // Also the fallback: the page's own click handler may be gone or renamed. Setting it twice is harmless.
    feed.scrollTop = feed.scrollHeight;
  }, checkMs);

  return {
    stop() {
      clearInterval(check);
      doc.removeEventListener('scroll', onScroll, true);
    },
  };
}
