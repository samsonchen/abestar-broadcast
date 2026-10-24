// Read-aloud on/off for one joined session (docs/tts-plan.md §3, §8): the audio channel, the listener
// heartbeat that tells the server someone is listening, and playback. Free of DOM and Supabase, so it is unit-tested.
import type { TtsClip } from '@abestar/shared';
import { AudioQueue, type LineKey } from './audio-queue';

export interface TtsBackend {
  /**
   * Marks this viewer as listening (for 90 s) in `lang`, or not; false when not joined or the session is not live.
   * The server synthesizes a line only when someone listens in its language.
   */
  setTts(sessionId: string, on: boolean, lang?: string | null): Promise<boolean>;
  /** Joins the session's private audio channel; returns a function that leaves it. */
  listen(
    sessionId: string,
    onClip: (clip: TtsClip) => void,
    onStatus?: (status: string) => void,
  ): () => void;
}

export interface Player {
  /**
   * Called from a tap (phones only allow audio after a user gesture). `fresh`: replace the audio context, which an
   * iPhone that was locked can leave claiming to run while silent.
   */
  unlock(fresh?: boolean): void;
  play(clip: TtsClip): Promise<void>;
  stop(): void;
}

export interface TtsView {
  active(on: boolean): void;
  speaking(line: LineKey | null): void;
  /** Read-aloud is on but the phone only plays audio again after a tap. */
  needsTap(on: boolean): void;
  /** Read-aloud is on in `lang`, but the translation is now in another language; null once it is back. */
  waiting(lang: string | null): void;
}

/** Primary language subtag, as the server keys voices: `zh-TW` → `zh`. */
export function primaryLang(tag: string | null | undefined): string | null {
  return tag ? (tag.split(/[-_]/)[0] ?? '').toLowerCase() || null : null;
}

export const HEARTBEAT_MS = 60_000;

export class Tts {
  private on = false;
  private leave: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Woken up since the last tap: the next tap restarts audio from scratch. */
  private slept = false;
  /** The broadcast's read-aloud language now (the session's tts_lang). */
  private current: string | null = null;
  /** The language this viewer turned read-aloud on in; it keeps listening for that one only. */
  private wanted: string | null = null;
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
    this.wanted = this.current;
    this.player.unlock();
    this.join();
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
    this.view.needsTap(false);
    this.view.waiting(null);
    this.view.active(false);
    if (tellServer) void this.backend.setTts(this.sessionId, false).catch(() => {});
  }

  /**
   * The page is shown again, e.g. after the phone was locked. Sleep can leave a clip that never finishes, the
   * audio suspended (or claiming to run while silent) and the audio channel dead, and heartbeats were missed: start
   * over as turning read-aloud off and on would. Audio itself needs a tap on an iPhone, so ask for one (see `tap`).
   */
  wake(): void {
    if (!this.on) return;
    this.queue.clear();
    this.player.stop();
    this.join();
    this.beat();
    this.slept = true;
    this.view.needsTap(true);
  }

  /**
   * The broadcast's read-aloud language changed (the presenter switched Abestar's target language), or is null when
   * the new language has no voices. A viewer listening in another language waits, silently, until it returns.
   */
  setLanguage(lang: string | null): void {
    if (lang === this.current) return;
    this.current = lang;
    if (!this.on) return;
    this.view.waiting(lang === this.wanted ? null : this.wanted);
  }

  /** Any tap on the page: a gesture lets phones play audio again; after a sleep, with a new audio context. */
  tap(): void {
    if (!this.on) return;
    this.player.unlock(this.slept);
    this.slept = false;
    this.view.needsTap(false);
  }

  /** (Re)joins the audio channel. */
  private join(): void {
    this.leave?.();
    this.leave = this.backend.listen(this.sessionId, (clip) => {
      if (!this.on || clip.session_id !== this.sessionId) return;
      // Lines of another language are not made for this viewer, but another viewer may want them.
      if (this.wanted && primaryLang(clip.lang) !== this.wanted) return;
      this.queue.push(clip);
    });
  }

  private beat(): void {
    void this.backend.setTts(this.sessionId, true, this.wanted).catch(() => {});
  }
}
