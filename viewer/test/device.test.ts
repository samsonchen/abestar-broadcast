// The screen wake lock, with a fake Wake Lock API that, like iPhone Safari, refuses it until the page is tapped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wakeLock } from '../src/device';

let tapped: boolean;
let held: number;
let needsTap: boolean[];
let lock: ReturnType<typeof wakeLock>;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const tap = async () => {
  tapped = true; // user activation lasts while the handlers run
  document.dispatchEvent(new Event('touchend'));
  await flush();
};

beforeEach(() => {
  tapped = false;
  held = 0;
  needsTap = [];
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        if (!tapped) throw new DOMException('Permission was denied', 'NotAllowedError');
        held++;
        const sentinel = new EventTarget() as WakeLockSentinel;
        sentinel.release = async () => {
          held--;
        };
        return sentinel;
      },
    },
  });
  lock = wakeLock(
    () => {},
    (on) => needsTap.push(on),
  );
});

afterEach(() => {
  lock.set(false);
  vi.restoreAllMocks();
});

describe('wakeLock', () => {
  it('asks for a tap when the phone refuses the lock without one, and takes it on the tap', async () => {
    lock.set(true);
    await flush();
    expect(held).toBe(0);
    expect(needsTap).toEqual([true]);
    await tap();
    expect(held).toBe(1);
    expect(needsTap).toEqual([true, false]);
  });

  it('releases the lock and the request for a tap when no longer wanted', async () => {
    lock.set(true);
    await flush();
    lock.set(false);
    expect(needsTap.at(-1)).toBe(false);
    await tap();
    expect(held).toBe(0);
  });
});
