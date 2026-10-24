// Content script on Abestar pages: runs capture while the background says this tab is broadcasting.

import type { CaptureMessage } from '@abestar/shared';
import type { HelloReply, ToBackground, ToContent } from '../messages';
import { startCapture, type Capture } from './capture';
import { followBottom, type Follow } from './follow';

declare global {
  interface Window {
    __abestarBroadcast?: boolean;
  }
}

// The manifest and the options page's extra hosts may both inject this script.
if (!window.__abestarBroadcast) {
  window.__abestarBroadcast = true;

  let capture: Capture | null = null;
  let follow: Follow | null = null;

  const toBackground = (message: ToBackground) => chrome.runtime.sendMessage(message);
  // A settled card never changes again, so a lost message would be a lost line: retry while the
  // worker restarts.
  const send = async (message: CaptureMessage, attempt = 0): Promise<void> => {
    try {
      await toBackground({ kind: 'capture', message });
    } catch {
      if (attempt < 5) setTimeout(() => void send(message, attempt + 1), 500 * 2 ** attempt);
    }
  };

  const start = (debounceMs: number) => {
    capture?.stop();
    follow?.stop();
    capture = startCapture(document, (m) => void send(m), { debounceMs });
    follow = followBottom(document);
  };

  chrome.runtime.onMessage.addListener((message: ToContent, _sender, reply) => {
    if (message.kind === 'start') start(message.debounceMs);
    if (message.kind === 'stop') {
      capture?.stop();
      follow?.stop();
      capture = null;
      follow = null;
    }
    reply({ ok: true });
  });

  // After a reload of the broadcasting tab, carry on in a new epoch.
  void (toBackground({ kind: 'hello' }) as Promise<HelloReply>)
    .then((r) => {
      if (r.capture) start(r.debounceMs);
    })
    .catch(() => {});
}
