// Plays read-aloud clips with Web Audio. An AudioContext resumed inside a tap keeps working on iPhones,
// where separate <audio> elements would each need their own gesture.
import type { Player } from './tts';

function bytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

export function webAudioPlayer(): Player {
  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let finish: (() => void) | null = null;
  let stops = 0; // a stop during decoding cancels that clip

  return {
    unlock() {
      ctx ??= new AudioContext();
      void ctx.resume();
      // A silent sample started in the gesture unlocks output on iOS.
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, 22050);
      silent.connect(ctx.destination);
      silent.start();
    },

    async play(clip) {
      const audio = ctx;
      const stopsBefore = stops;
      if (!audio) return;
      if (audio.state === 'suspended') await audio.resume().catch(() => {});
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
        node.onended = () => {
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
