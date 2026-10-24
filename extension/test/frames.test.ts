// Keeping Abestar's requestAnimationFrame typing alive in a background tab, with a fake window and clock.
import { beforeEach, describe, expect, it } from 'vitest';
import { type Clock, keepFramesRunning, type KeepFrames } from '../src/content/frames';

/** A window whose real frames run only when the test says so, and only while visible. */
function fakeWindow() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextNative = 1;
  const doc = new EventTarget() as EventTarget & { hidden: boolean };
  doc.hidden = false;
  const win = {
    document: doc as unknown as Document,
    performance: { now: () => 1000 } as Performance,
    requestAnimationFrame(cb: FrameRequestCallback) {
      frames.set(nextNative, cb);
      return nextNative++;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  };
  return {
    win,
    /** Chrome draws a frame (it does not while the tab is hidden). */
    frame() {
      if (doc.hidden) return;
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(16);
    },
    setHidden(hidden: boolean) {
      doc.hidden = hidden;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    get nativeWaiting() {
      return frames.size;
    },
  };
}

function fakeClock() {
  let onTick: (() => void) | null = null;
  const clock: Clock = {
    start: (fn) => (onTick = fn),
    stop: () => (onTick = null),
  };
  return {
    clock,
    get running() {
      return onTick !== null;
    },
    tick: () => onTick?.(),
  };
}

/** Abestar's typing: each frame types a character and asks for the next frame, until the text is done. */
function typewriter(
  win: { requestAnimationFrame(cb: FrameRequestCallback): number },
  text: string,
) {
  let shown = '';
  const step = () => {
    shown = text.slice(0, shown.length + 1);
    if (shown.length < text.length) win.requestAnimationFrame(step);
  };
  win.requestAnimationFrame(step);
  return () => shown;
}

let page: ReturnType<typeof fakeWindow>;
let clock: ReturnType<typeof fakeClock>;
let frames: KeepFrames;

beforeEach(() => {
  page = fakeWindow();
  clock = fakeClock();
  frames = keepFramesRunning(page.win, clock.clock);
});

describe('keepFramesRunning', () => {
  it('passes straight through outside a broadcast', () => {
    const shown = typewriter(page.win, 'Hello');
    page.setHidden(true);
    clock.tick();
    expect(shown()).toBe('');
    expect(clock.running).toBe(false);
    page.setHidden(false);
    for (let i = 0; i < 5; i++) page.frame();
    expect(shown()).toBe('Hello');
  });

  it('uses real frames while the tab is visible', () => {
    frames.setActive(true);
    const shown = typewriter(page.win, 'Hello');
    for (let i = 0; i < 5; i++) page.frame();
    expect(shown()).toBe('Hello');
    expect(clock.running).toBe(false);
  });

  it('keeps typing on the clock while the tab is hidden, including a frame already requested', () => {
    frames.setActive(true);
    const shown = typewriter(page.win, 'Hello');
    page.frame();
    expect(shown()).toBe('H');
    page.setHidden(true); // the next frame was requested from Chrome, which will not draw it now
    expect(clock.running).toBe(true);
    clock.tick(); // up to FRAMES_PER_TICK frames per tick: Chrome slows even a worker's timer when hidden
    expect(shown()).toBe('Hello');
    clock.tick(); // nothing left to run
    expect(clock.running).toBe(false);
  });

  it('runs each callback once, whichever comes first', () => {
    frames.setActive(true);
    let calls = 0;
    page.win.requestAnimationFrame(() => calls++);
    page.setHidden(true);
    clock.tick();
    page.setHidden(false);
    page.frame();
    expect(calls).toBe(1);
    expect(page.nativeWaiting).toBe(0);
  });

  it('hands waiting callbacks back to Chrome when the tab is shown again', () => {
    frames.setActive(true);
    page.setHidden(true);
    const shown = typewriter(page.win, 'Hi');
    page.setHidden(false);
    expect(clock.running).toBe(false);
    page.frame();
    page.frame();
    expect(shown()).toBe('Hi');
  });

  it('cancels a callback before it runs', () => {
    frames.setActive(true);
    let calls = 0;
    const id = page.win.requestAnimationFrame(() => calls++);
    expect(id).toBeLessThan(0); // never confused with Chrome's ids
    page.win.cancelAnimationFrame(id);
    page.setHidden(true);
    clock.tick();
    page.setHidden(false);
    page.frame();
    expect(calls).toBe(0);
  });

  it('cancels a frame requested before the broadcast started', () => {
    let calls = 0;
    const id = page.win.requestAnimationFrame(() => calls++);
    frames.setActive(true);
    page.win.cancelAnimationFrame(id);
    page.frame();
    expect(calls).toBe(0);
  });

  it('stops the clock and returns to real frames when the broadcast ends', () => {
    frames.setActive(true);
    page.setHidden(true);
    const shown = typewriter(page.win, 'Hey there');
    clock.tick();
    expect(shown()).toBe('Hey ');
    frames.setActive(false);
    expect(clock.running).toBe(false);
    page.setHidden(false);
    for (let i = 0; i < 5; i++) page.frame();
    expect(shown()).toBe('Hey there');
  });

  it('keeps running the other callbacks when one throws', () => {
    frames.setActive(true);
    page.setHidden(true);
    let ran = false;
    page.win.requestAnimationFrame(() => {
      throw new Error('boom');
    });
    page.win.requestAnimationFrame(() => (ran = true));
    const errors: unknown[] = [];
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      try {
        fn();
      } catch (e) {
        errors.push(e);
      }
      return 0;
    }) as typeof setTimeout;
    try {
      clock.tick();
    } finally {
      globalThis.setTimeout = original;
    }
    expect(ran).toBe(true);
    expect(errors).toHaveLength(1);
  });
});
