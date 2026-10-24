// Keeps Abestar typing while its tab is in the background. Abestar types each translation into the page with
// requestAnimationFrame (about 2 characters per frame), and Chrome runs no animation frames in a hidden tab, so the
// text, and with it the broadcast, would stop until the presenter came back. This wraps requestAnimationFrame from
// page start (in case Abestar keeps a reference to it). Outside a broadcast the wrapper passes straight through.
// During one, callbacks still run on Chrome's frames while the tab is visible, and on `clock` while it is hidden;
// the clock ticks from a worker, whose timers Chrome does not pause in background tabs.
//
// It runs in the page's own JavaScript world (content/main-world.ts), since Abestar calls the page's
// requestAnimationFrame; it is pure apart from the window it is given, so it is unit-tested.

/** Frames run per clock tick while hidden, to keep up with a visible tab's 60 a second. */
export const FRAMES_PER_TICK = 4;

/** Ticks about every frame (16 ms) while started. */
export interface Clock {
  start(onTick: () => void): void;
  stop(): void;
}

export interface KeepFrames {
  /** The broadcast started or ended. */
  setActive(on: boolean): void;
}

type FrameWindow = Pick<
  Window,
  'requestAnimationFrame' | 'cancelAnimationFrame' | 'document' | 'performance'
>;

interface Pending {
  callback: FrameRequestCallback;
  /** Chrome's id, while the callback also waits for a real frame. */
  nativeId?: number;
}

export function keepFramesRunning(win: FrameWindow, clock: Clock): KeepFrames {
  const nativeRequest = win.requestAnimationFrame.bind(win);
  const nativeCancel = win.cancelAnimationFrame.bind(win);
  const doc = win.document;
  const pending = new Map<number, Pending>();
  // Negative, so they never collide with Chrome's own (positive) ids handed out outside a broadcast.
  let nextId = -1;
  let active = false;
  let ticking = false;

  /** Runs one callback once, whichever of a real frame or the clock comes first. */
  const run = (id: number, time: number) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.nativeId !== undefined) nativeCancel(entry.nativeId);
    try {
      entry.callback(time);
    } catch (e) {
      setTimeout(() => {
        throw e; // reported like an uncaught error in a real frame, without stopping the others
      });
    }
  };

  const viaChrome = (id: number, entry: Pending) => {
    entry.nativeId = nativeRequest((time) => run(id, time));
  };

  const tick = () => {
    if (!doc.hidden || pending.size === 0) return stopClock();
    // Chrome slows even worker timers in a hidden tab, to about 15 ticks a second (measured 2026-10-24), so each
    // tick runs up to FRAMES_PER_TICK frames: callbacks requested by one frame run in the next.
    for (let frame = 0; frame < FRAMES_PER_TICK && pending.size > 0; frame++) {
      const time = win.performance.now();
      for (const id of [...pending.keys()]) run(id, time);
    }
  };
  const startClock = () => {
    if (ticking) return;
    ticking = true;
    clock.start(tick);
  };
  const stopClock = () => {
    if (!ticking) return;
    ticking = false;
    clock.stop();
  };

  win.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    if (!active) return nativeRequest(callback);
    const id = nextId--;
    const entry: Pending = { callback };
    pending.set(id, entry);
    if (doc.hidden) startClock();
    else viaChrome(id, entry);
    return id;
  };
  win.cancelAnimationFrame = (id: number) => {
    if (id > 0) return nativeCancel(id);
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.nativeId !== undefined) nativeCancel(entry.nativeId);
  };

  doc.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (doc.hidden) {
      // Callbacks waiting for a real frame would wait until the tab is shown again.
      if (pending.size > 0) startClock();
    } else {
      stopClock();
      for (const [id, entry] of pending) if (entry.nativeId === undefined) viaChrome(id, entry);
    }
  });

  return {
    setActive(on) {
      if (on === active) return;
      active = on;
      if (on) return;
      stopClock();
      // Callbacks already handed out still run, now on Chrome's frames.
      for (const [id, entry] of pending) if (entry.nativeId === undefined) viaChrome(id, entry);
    },
  };
}

/** A Clock driven by a worker's timer; falls back to the page's own (throttled) timer if workers are blocked. */
export function workerClock(): Clock {
  let worker: Worker | null = null;
  let fallback: ReturnType<typeof setInterval> | undefined;
  return {
    start(onTick) {
      try {
        if (!worker) {
          const source =
            'let t;onmessage=(e)=>{clearInterval(t);if(e.data)t=setInterval(()=>postMessage(0),16)}';
          worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        }
        worker.onmessage = () => onTick();
        worker.postMessage(true);
      } catch {
        worker = null;
        fallback = setInterval(onTick, 16);
      }
    },
    stop() {
      worker?.postMessage(false);
      clearInterval(fallback);
      fallback = undefined;
    },
  };
}
