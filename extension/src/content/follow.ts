// Keeps Abestar's translation column at the newest line while the broadcast runs and the presenter is not using the
// Abestar tab (another tab or window has focus, e.g. slides with Abestar on a second screen). Abestar itself stops
// following new lines in a background tab and shows a ↓ button, which looks frozen. While the Abestar tab has
// focus, Abestar's own scrolling applies, so the presenter can still scroll back.

import { TRANSLATION_COLUMN } from './selectors';

export interface Follow {
  stop(): void;
}

export function followBottom(doc: Document): Follow {
  const away = () => doc.hidden || !doc.hasFocus();
  const toBottom = () => {
    const column = doc.querySelector(TRANSLATION_COLUMN);
    if (column) column.scrollTop = column.scrollHeight;
  };
  const onChange = () => {
    if (away()) toBottom();
  };

  toBottom(); // the broadcast starts at the newest line
  // New cards, and text growing in the last card, both make the column taller.
  const observer = new MutationObserver(onChange);
  observer.observe(doc, { subtree: true, childList: true, characterData: true });
  // Leaving the tab or the window: catch up at once rather than on the next line.
  doc.addEventListener('visibilitychange', onChange);
  doc.defaultView?.addEventListener('blur', toBottom);

  return {
    stop() {
      observer.disconnect();
      doc.removeEventListener('visibilitychange', onChange);
      doc.defaultView?.removeEventListener('blur', toBottom);
    },
  };
}
