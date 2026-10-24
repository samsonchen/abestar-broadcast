// Read-aloud playback and on/off (docs/tts-plan.md §8), with a fake player and backend.
import type { TtsClip } from '@abestar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioQueue, type LineKey } from '../src/audio-queue';
import { HEARTBEAT_MS, type Player, Tts, type TtsBackend } from '../src/tts';
import { SESSION } from './rows';

const clip = (seq: number, part = 0, parts = 1, epoch = 0): TtsClip => ({
  session_id: SESSION.id,
  epoch,
  seq,
  part,
  parts,
  lang: 'en-US',
  text_version: 1,
  format: 'mp3_22050_32',
  audio: `${epoch}:${seq}:${part}`,
});

/** A player whose clips finish only when the test says so. */
function fakePlayer() {
  const played: string[] = [];
  const pending: (() => void)[] = [];
  const player: Player & { unlocked: number; stopped: number; running: boolean } = {
    unlocked: 0,
    stopped: 0,
    running: true,
    unlock() {
      player.unlocked++;
      player.running = true;
    },
    resume: async () => player.running,
    play(c) {
      played.push(c.audio);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    stop() {
      player.stopped++;
      pending.splice(0).forEach((finish) => finish());
    },
  };
  return {
    player,
    played,
    /** Finishes the clip that is playing. */
    async finish() {
      pending.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

let fake: ReturnType<typeof fakePlayer>;
let speaking: (LineKey | null)[];

beforeEach(() => {
  vi.useFakeTimers();
  fake = fakePlayer();
  speaking = [];
});
afterEach(() => vi.useRealTimers());

function queue() {
  return new AudioQueue({
    play: (c) => fake.player.play(c),
    speaking: (line) => speaking.push(line),
  });
}

describe('AudioQueue', () => {
  it('plays clips one at a time in line order and marks the line being spoken', async () => {
    const q = queue();
    q.push(clip(1));
    q.push(clip(3));
    q.push(clip(2)); // arrived out of order, plays before 3
    expect(fake.played).toEqual(['0:1:0']);
    await fake.finish();
    await fake.finish();
    await fake.finish();
    expect(fake.played).toEqual(['0:1:0', '0:2:0', '0:3:0']);
    expect(speaking).toEqual(['0:1', '0:2', '0:3', null]);
  });

  it('plays the parts of a long line together, as one speaking line', async () => {
    const q = queue();
    q.push(clip(1, 0, 2));
    q.push(clip(1, 1, 2));
    await fake.finish();
    await fake.finish();
    expect(fake.played).toEqual(['0:1:0', '0:1:1']);
    expect(speaking).toEqual(['0:1', null]);
  });

  it('never goes back to a line older than the one played', async () => {
    const q = queue();
    q.push(clip(5));
    await fake.finish();
    q.push(clip(4));
    q.push(clip(5)); // duplicate
    expect(fake.played).toEqual(['0:5:0']);
  });

  it('drops the oldest waiting lines when more than two wait', async () => {
    const q = queue();
    q.push(clip(1)); // playing
    for (const seq of [2, 3, 4, 5]) q.push(clip(seq));
    for (let i = 0; i < 4; i++) await fake.finish();
    expect(fake.played).toEqual(['0:1:0', '0:4:0', '0:5:0']);
  });

  it('orders by epoch first (the presenter reloaded Abestar)', async () => {
    const q = queue();
    q.push(clip(9, 0, 1, 0));
    q.push(clip(1, 0, 1, 1));
    await fake.finish();
    await fake.finish();
    expect(fake.played).toEqual(['0:9:0', '1:1:0']);
  });

  it('clear forgets the waiting clips and the speaking mark', async () => {
    const q = queue();
    q.push(clip(1));
    q.push(clip(2));
    q.clear();
    await fake.finish();
    expect(fake.played).toEqual(['0:1:0']);
    expect(speaking.at(-1)).toBeNull();
    q.push(clip(1)); // a fresh start may replay from anywhere
    expect(fake.played).toEqual(['0:1:0', '0:1:0']);
  });
});

function fakeBackend() {
  let onClip: ((c: TtsClip) => void) | null = null;
  const backend = {
    setTts: vi.fn<TtsBackend['setTts']>(async () => true),
    listen: vi.fn<TtsBackend['listen']>((_id, on) => {
      onClip = on;
      return () => (onClip = null);
    }),
  };
  return {
    backend,
    get listening() {
      return onClip !== null;
    },
    send: (c: TtsClip) => onClip?.(c),
  };
}

describe('Tts', () => {
  let server: ReturnType<typeof fakeBackend>;
  let active: boolean[];
  let needsTap: boolean[];
  let tts: Tts;

  beforeEach(() => {
    server = fakeBackend();
    active = [];
    needsTap = [];
    tts = new Tts(server.backend, SESSION.id, fake.player, {
      active: (on) => active.push(on),
      speaking: (line) => speaking.push(line),
      needsTap: (on) => needsTap.push(on),
    });
  });

  it('is off until turned on, and then listens, unlocks audio and tells the server', () => {
    expect(tts.enabled).toBe(false);
    expect(server.backend.listen).not.toHaveBeenCalled();
    tts.toggle();
    expect(tts.enabled).toBe(true);
    expect(server.listening).toBe(true);
    expect(fake.player.unlocked).toBe(1);
    expect(server.backend.setTts).toHaveBeenCalledWith(SESSION.id, true);
    expect(active).toEqual([true]);
  });

  it('plays what arrives while on', async () => {
    tts.enable();
    server.send(clip(1));
    server.send({ ...clip(2), session_id: 'another-session' });
    await fake.finish();
    expect(fake.played).toEqual(['0:1:0']);
  });

  it('sends a heartbeat every minute while on, and at once when the phone wakes up', async () => {
    tts.enable();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(server.backend.setTts).toHaveBeenCalledTimes(3);
    tts.wake();
    expect(server.backend.setTts).toHaveBeenCalledTimes(4);
  });

  it('turning off stops playback, leaves the channel, tells the server and stops the heartbeat', async () => {
    tts.enable();
    server.send(clip(1));
    tts.toggle();
    expect(fake.player.stopped).toBe(1);
    expect(server.listening).toBe(false);
    expect(server.backend.setTts).toHaveBeenLastCalledWith(SESSION.id, false);
    expect(speaking.at(-1)).toBeNull();
    expect(active).toEqual([true, false]);
    const calls = server.backend.setTts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    tts.wake();
    expect(server.backend.setTts).toHaveBeenCalledTimes(calls);
  });

  it('does not call the server when turned off because the session ended', () => {
    tts.enable();
    tts.disable(false);
    expect(server.backend.setTts).not.toHaveBeenCalledWith(SESSION.id, false);
  });

  it('starts over when the phone wakes up: rejoins the channel and drops a clip left hanging', async () => {
    tts.enable();
    server.send(clip(1)); // its playback never finishes: the phone slept mid-clip
    expect(fake.played).toEqual(['0:1:0']);
    tts.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.backend.listen).toHaveBeenCalledTimes(2);
    expect(fake.player.stopped).toBe(1);
    expect(needsTap).toEqual([false]);
    server.send(clip(2));
    expect(fake.played).toEqual(['0:1:0', '0:2:0']);
  });

  it('asks for a tap when the phone will not play audio again without one', async () => {
    tts.enable();
    fake.player.running = false;
    tts.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(needsTap).toEqual([true]);
    tts.tap();
    expect(fake.player.unlocked).toBe(2);
    expect(needsTap).toEqual([true, false]);
  });

  it('ignores wake-ups and taps while off', async () => {
    tts.wake();
    tts.tap();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.backend.listen).not.toHaveBeenCalled();
    expect(fake.player.unlocked).toBe(0);
    expect(needsTap).toEqual([]);
  });

  it('survives a failing heartbeat', async () => {
    server.backend.setTts.mockRejectedValue(new Error('offline'));
    tts.enable();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(tts.enabled).toBe(true);
  });
});
