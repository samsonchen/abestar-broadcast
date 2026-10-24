// Plays read-aloud clips with Web Audio. An AudioContext resumed inside a tap keeps working on iPhones,
// where separate <audio> elements would each need their own gesture.
import type { Player } from './tts';

function bytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/** `onState` reports the AudioContext's state (running, suspended, interrupted on iPhones), for `?debug`. */
/** AudioContext.resume() can stay pending on iPhones until a tap; wait at most `ms`. */
function resumeWithin(ctx: AudioContext, ms: number): Promise<void> {
  return Promise.race([
    ctx.resume().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

export function webAudioPlayer(onState: (state: string) => void = () => {}): Player {
  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let finish: (() => void) | null = null;
  let stops = 0; // a stop during decoding cancels that clip

  return {
    unlock() {
      if (!ctx) {
        const created = new AudioContext();
        created.addEventListener('statechange', () => onState(created.state));
        ctx = created;
      }
      void ctx.resume();
      // A silent sample started in the gesture unlocks output on iOS.
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, 22050);
      silent.connect(ctx.destination);
      silent.start();
    },

    async resume() {
      if (!ctx) return false;
      if (ctx.state !== 'running') await resumeWithin(ctx, 1000);
      return ctx.state === 'running';
    },

    async play(clip) {
      const audio = ctx;
      const stopsBefore = stops;
      if (!audio) return;
      // 'suspended', or 'interrupted' on an iPhone that was locked
      if (audio.state !== 'running') await resumeWithin(audio, 1000);
      let buffer: AudioBuffer;
      try {
        buffer = await audio.decodeAudioData(bytes(clip.audio));
      } catch {
        return; // a damaged clip is skipped
      }
      if (stops !== stopsBefore) return;
      await new Promise<void>((resolve) => {
        const node = audio.createBufferSource();
        node.buffer = buffer;
        node.connect(audio.destination);
        finish = resolve;
        // If the phone suspends audio mid-clip, `ended` may never come; do not hold the queue forever.
        const guard = setTimeout(resolve, (buffer.duration + 2) * 1000);
        node.onended = () => {
          clearTimeout(guard);
          if (source === node) source = null;
          resolve();
        };
        source = node;
        node.start();
      });
    },

    stop() {
      stops++;
      source?.stop();
      source = null;
      finish?.();
      finish = null;
    },
  };
}
