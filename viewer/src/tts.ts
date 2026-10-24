// Read-aloud on/off for one joined session (docs/tts-plan.md §3, §8): the audio channel, the listener
// heartbeat that tells the server someone is listening, and playback. Free of DOM and Supabase, so it is unit-tested.
import type { TtsClip } from '@abestar/shared';
import { AudioQueue, type LineKey } from './audio-queue';

export interface TtsBackend {
  /** Marks this viewer as listening (for 90 s) or not; false when not joined or the session is not live. */
  setTts(sessionId: string, on: boolean): Promise<boolean>;
  /** Joins the session's private audio channel; returns a function that leaves it. */
  listen(sessionId: string, onClip: (clip: TtsClip) => void): () => void;
}

export interface Player {
  /** Called from the tap that turns read-aloud on; phones only allow audio after a user gesture. */
  unlock(): void;
  play(clip: TtsClip): Promise<void>;
  stop(): void;
}

export interface TtsView {
  active(on: boolean): void;
  speaking(line: LineKey | null): void;
}

export const HEARTBEAT_MS = 60_000;

export class Tts {
  private on = false;
  private leave: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly queue: AudioQueue;

  constructor(
    private readonly backend: TtsBackend,
    private readonly sessionId: string,
    private readonly player: Player,
    private readonly view: TtsView,
  ) {
    this.queue = new AudioQueue({
      play: (clip) => player.play(clip),
      speaking: (line) => view.speaking(line),
    });
  }

  get enabled(): boolean {
    return this.on;
  }

  toggle(): void {
    if (this.on) this.disable();
    else this.enable();
  }

  enable(): void {
    if (this.on) return;
    this.on = true;
    this.player.unlock();
    this.leave = this.backend.listen(this.sessionId, (clip) => {
      if (this.on && clip.session_id === this.sessionId) this.queue.push(clip);
    });
    this.beat();
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.view.active(true);
  }

  /** `tellServer` is false when the session ended or the page is going away and the call cannot matter. */
  disable(tellServer = true): void {
    if (!this.on) return;
    this.on = false;
    clearInterval(this.heartbeat);
    this.leave?.();
    this.leave = null;
    this.queue.clear();
    this.player.stop();
    this.view.active(false);
    if (tellServer) void this.backend.setTts(this.sessionId, false).catch(() => {});
  }

  /** A phone that slept missed heartbeats; renew at once when it wakes up. */
  wake(): void {
    if (this.on) this.beat();
  }

  private beat(): void {
    void this.backend.setTts(this.sessionId, true).catch(() => {});
  }
}
