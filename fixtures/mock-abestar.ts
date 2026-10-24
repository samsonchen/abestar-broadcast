// Replica of Abestar GO!'s presentation page, enough for capture tests and e2e (PLAN.md §2.2, §2.5).
// Each DOM operation and timing mirrors fixtures/logs/raw-session-1.json, which
// fixtures/test/mock-fidelity.test.ts checks.

export const DOTS_INTERVAL_MS = 400;
/** Gap between emptying the placeholder `<p>` and the first typed characters. */
export const FIRST_CHARS_DELAY_MS = 23;
export const TYPING_FRAME_MS = 1000 / 60;
export const CHARS_PER_FRAME = 2;

const CARD_CLASS = 'relative rounded-lg p-2 xl:p-4 shadow-md bg-slate-50';
const TEXT_CLASS = 'text-lg font-medium text-gray-700';
const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" ' +
  'class="lucide lucide-check-check absolute top-0.5 right-1 w-3 h-3 text-amber-500">' +
  '<path d="M18 6 7 17l-5-5"></path><path d="m22 10-7.5 7.5L13 16"></path></svg>';

export type TimelineStep =
  | { at: number; action: 'add'; source?: string }
  | { at: number; action: 'resolve'; n: number; text: string }
  | { at: number; action: 'clear' };

/** The real session behind raw-session-1.json: when each card appeared and when its translation arrived. */
export const SESSION_1: TimelineStep[] = [
  { at: 0, action: 'add' },
  { at: 5307, action: 'resolve', n: 1, text: 'Chinese test, testing translation.' },
  { at: 6929, action: 'add' },
  { at: 9577, action: 'add' },
  { at: 11024, action: 'resolve', n: 2, text: 'Come and check out the Furry Kid Market.' },
  { at: 14953, action: 'add' },
  {
    at: 15255,
    action: 'resolve',
    n: 3,
    text: 'Healthy and flexible for brisk walking, or enhanced maintenance for joint degeneration warnings.',
  },
  { at: 20757, action: 'resolve', n: 4, text: 'Pet joint health self-assessment form.' },
];

export interface MockAbestar {
  /** Appends a placeholder card with cycling dots; returns its N. */
  addPending(source?: string): number;
  /** Replaces placeholder N with `text`, typed in like Abestar does. */
  resolve(n: number, text: string): void;
  /** Broom button: removes every card and restarts N at 1. */
  clear(): void;
  /** N of every card still showing dots, oldest first. */
  pending(): number[];
  play(timeline: TimelineStep[]): void;
  /** Cancels all timers (dots, typing, timeline). */
  stop(): void;
}

interface PendingCard {
  card: HTMLElement;
  p: HTMLElement;
  dots: ReturnType<typeof setInterval>;
}

export interface MockOptions {
  /**
   * Type with requestAnimationFrame, as the real page does (checked on 2026-10-24: 251 frames for one sentence,
   * no short timers), so Chrome pauses the typing in a background tab. The default, a 60 Hz timer, suits jsdom and
   * fake timers.
   */
  animationFrames?: boolean;
}

export function mountMock(
  root: HTMLElement,
  lang = 'en-US',
  sourceLang = 'zh-TW',
  { animationFrames = false }: MockOptions = {},
): MockAbestar {
  const doc = root.ownerDocument;
  const win = doc.defaultView as Window;
  root.innerHTML =
    '<div class="flex gap-4">' +
    `<section class="flex-1"><h2>Speaker <span>(${sourceLang})</span></h2>` +
    '<div data-testid="col-left" class="min-h-0 flex-1 overflow-y-auto"><div class="flex flex-col gap-3 px-3"></div></div></section>' +
    `<section class="flex-1"><h2>Translation <span>(${lang})</span></h2>` +
    '<div data-testid="col-right" class="min-h-0 flex-1 overflow-y-auto"><div class="flex flex-col gap-3 px-3"><div></div></div></div></section>' +
    '</div>';
  const sourceList = root.querySelector('[data-testid="col-left"] > div') as HTMLElement;
  const list = root.querySelector('[data-testid="col-right"] > div') as HTMLElement;
  const spacer = list.lastElementChild as HTMLElement;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pendingCards = new Map<number, PendingCard>();
  let lastN = 0;

  const later = (ms: number, fn: () => void) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  const every = (ms: number, fn: () => void) => {
    const id = setInterval(fn, ms);
    timers.add(id);
    return id;
  };

  const cancel = (id: ReturnType<typeof setTimeout>) => {
    clearTimeout(id);
    clearInterval(id);
    timers.delete(id);
  };

  /** Animation frames in flight, cancelled by stop(). */
  const frames = new Set<number>();
  /** Calls fn on every typing frame until it returns false. */
  const typeEachFrame = (fn: () => boolean) => {
    if (!animationFrames) {
      const typing = every(TYPING_FRAME_MS, () => {
        if (!fn()) cancel(typing);
      });
      return;
    }
    const step = () => {
      frames.delete(id);
      if (fn()) {
        id = win.requestAnimationFrame(step);
        frames.add(id);
      }
    };
    let id = win.requestAnimationFrame(step);
    frames.add(id);
  };

  const mock: MockAbestar = {
    addPending(source) {
      const n = ++lastN;
      const card = doc.createElement('div');
      card.setAttribute('lang', lang);
      card.setAttribute('data-testid', `translation-${n}`);
      card.className = CARD_CLASS;
      const p = doc.createElement('p');
      p.setAttribute('data-testid', `translation-dots-${n}`);
      p.className = TEXT_CLASS;
      const dotsText = doc.createTextNode('.');
      p.append(dotsText);
      card.append(p);
      list.insertBefore(card, spacer);

      if (source) {
        const line = doc.createElement('p');
        line.className = TEXT_CLASS;
        line.textContent = source;
        sourceList.append(line);
      }

      const dots = every(DOTS_INTERVAL_MS, () => {
        dotsText.data = '.'.repeat((dotsText.data.length % 3) + 1);
      });
      pendingCards.set(n, { card, p, dots });
      return n;
    },

    resolve(n, text) {
      const pending = pendingCards.get(n);
      if (!pending) throw new Error(`translation-${n} is not pending`);
      pendingCards.delete(n);
      cancel(pending.dots);
      const { card, p } = pending;

      // Same order as React's reconciliation in the recorded log.
      const icon = doc.createElement('template');
      icon.innerHTML = CHECK_ICON;
      card.insertBefore(icon.content.firstChild as Node, p);
      p.removeAttribute('data-testid');
      p.textContent = '';

      later(FIRST_CHARS_DELAY_MS, () => {
        let shown = Math.min(CHARS_PER_FRAME, text.length);
        const typed = doc.createTextNode(text.slice(0, shown));
        p.append(typed);
        if (shown >= text.length) return;
        typeEachFrame(() => {
          shown = Math.min(shown + CHARS_PER_FRAME, text.length);
          typed.data = text.slice(0, shown);
          return shown < text.length;
        });
      });
    },

    clear() {
      mock.stop();
      pendingCards.clear();
      lastN = 0;
      for (const el of Array.from(list.children)) if (el !== spacer) el.remove();
      sourceList.replaceChildren();
    },

    pending: () => Array.from(pendingCards.keys()),

    play(timeline) {
      for (const step of timeline) {
        later(step.at, () => {
          if (step.action === 'add') mock.addPending(step.source);
          else if (step.action === 'resolve') mock.resolve(step.n, step.text);
          else mock.clear();
        });
      }
    },

    stop() {
      for (const id of timers) cancel(id);
      for (const id of frames) win.cancelAnimationFrame(id);
      frames.clear();
    },
  };
  return mock;
}
