// Read-aloud playback order (docs/tts-plan.md §8): clips play one at a time in line order, never going back,
// and when more than `maxWaiting` lines are waiting the oldest are dropped so speech stays close to the text.
import type { TtsClip } from '@abestar/shared';

export type LineKey = string;
export const lineKey = (c: Pick<TtsClip, 'epoch' | 'seq'>): LineKey => `${c.epoch}:${c.seq}`;

const order = (a: TtsClip, b: TtsClip) => a.epoch - b.epoch || a.seq - b.seq || a.part - b.part;

export interface Playback {
  /** Plays one clip; resolves when it finished or was stopped. */
  play(clip: TtsClip): Promise<void>;
  /** The line being spoken, or null when nothing plays. */
  speaking(line: LineKey | null): void;
}

export class AudioQueue {
  private waiting: TtsClip[] = [];
  private current: TtsClip | null = null;
  private last: TtsClip | null = null;
  private running = false;
  private generation = 0;
  private speakingLine: LineKey | null = null;

  constructor(
    private readonly playback: Playback,
    private readonly maxWaiting = 2,
  ) {}

  push(clip: TtsClip): void {
    const newest = this.current ?? this.last;
    if (newest && order(clip, newest) <= 0) return; // already played, or older than what plays
    if (this.waiting.some((c) => order(c, clip) === 0)) return;
    this.waiting.push(clip);
    this.waiting.sort(order);

    const lines = [...new Set(this.waiting.map(lineKey))];
    // Parts of the line that is playing now do not count as waiting.
    const playing = this.current ? lineKey(this.current) : null;
    const waitingLines = lines.filter((l) => l !== playing);
    const drop = new Set(waitingLines.slice(0, Math.max(0, waitingLines.length - this.maxWaiting)));
    if (drop.size > 0) this.waiting = this.waiting.filter((c) => !drop.has(lineKey(c)));

    void this.run();
  }

  /** Forgets everything; a clip that is playing must be stopped by the caller. */
  clear(): void {
    this.generation++;
    this.waiting = [];
    this.current = null;
    this.last = null;
    this.running = false;
    this.speak(null);
  }

  private speak(line: LineKey | null): void {
    if (line === this.speakingLine) return;
    this.speakingLine = line;
    this.playback.speaking(line);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    let next: TtsClip | undefined;
    while ((next = this.waiting.shift())) {
      this.speak(lineKey(next));
      this.current = next;
      await this.playback.play(next);
      if (generation !== this.generation) return;
      this.last = next;
      this.current = null;
    }
    this.running = false;
    this.speak(null);
  }
}
