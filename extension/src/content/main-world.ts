// Runs in the Abestar page's own JavaScript world from page start (manifest `world: "MAIN"`): keeps Abestar typing
// in a background tab during a broadcast (frames.ts). content/index.ts switches it with the events below.

import { keepFramesRunning, workerClock } from './frames';
import { BROADCAST_OFF, BROADCAST_ON } from './signals';

declare global {
  interface Window {
    __abestarFrames?: boolean;
  }
}

// The manifest and the options page's extra hosts may both inject this script.
if (!window.__abestarFrames) {
  window.__abestarFrames = true;
  const frames = keepFramesRunning(window, workerClock());
  document.addEventListener(BROADCAST_ON, () => frames.setActive(true));
  document.addEventListener(BROADCAST_OFF, () => frames.setActive(false));
}
