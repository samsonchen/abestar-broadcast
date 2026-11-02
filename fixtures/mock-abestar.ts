// Replica of Abestar v2's audience page, enough for capture tests and e2e. Checked against
// fixtures/logs/v2-session-1.json and v2-page-excerpt.html by fixtures/test/mock-fidelity.test.ts.
import type { TimelineStep } from './timeline';

export interface MockLine {
  seq: number;
  status: string;
  text: string;
  lang: string;
}

export interface MockOptions {
  /** Show the language picker first; `enter()` or its button moves on to the feed. */
  picker?: boolean;
  /** Lines the page loads on entering, added in one batch after `historyDelayMs`, as on the real page. */
  history?: MockLine[];
  historyDelayMs?: number;
}

export interface MockAbestar {
  setInterim(text: string | null): void;
  addLine(line: MockLine): void;
  updateLine(seq: number, status: string, text: string): void;
  lines(): MockLine[];
  /** React replacing the feed element, with the same lines. */
  remountFeed(): void;
  /** Leaves the language picker. */
  enter(): void;
  play(steps: TimelineStep[]): void;
  stop(): void;
}

const PREFIX = 'mvy16ds3';
const TEXT_CLASS = 'break-words whitespace-pre-wrap text-[19px] leading-relaxed';
const CARD_CLASS = 'rounded-card bg-surface px-5 py-4 shadow-card';
const BOTTOM_SLOP_PX = 2;

export function mountMock(root: HTMLElement, options: MockOptions = {}): MockAbestar {
  const doc = root.ownerDocument;
  const { picker = false, history = [], historyDelayMs = 70 } = options;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const lines = new Map<number, { line: MockLine; p: HTMLElement }>();
  let wrapper: HTMLElement | null = null;
  let feed: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;
  let interim: HTMLElement | null = null;

  const later = (ms: number, fn: () => void) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };
  const atBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLOP_PX;
  const stick = (el: HTMLElement, wasAtBottom: boolean) => {
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  };
  const card = (p: HTMLElement) => {
    const div = doc.createElement('div');
    div.className = CARD_CLASS;
    div.append(p);
    return div;
  };
  const style = (p: HTMLElement, status: string) => {
    p.setAttribute('data-status', status);
    p.className = `${TEXT_CLASS} ${status === 'corrected' ? 'not-italic text-gray-900' : 'italic text-gray-400'}`;
  };
  const lineElement = (line: MockLine) => {
    const p = doc.createElement('p');
    p.setAttribute('data-testid', 'subtitle-line');
    p.setAttribute('data-seg-id', `${PREFIX}-${line.seq}`);
    p.setAttribute('data-lang', line.lang);
    p.setAttribute('lang', line.lang);
    style(p, line.status);
    p.textContent = line.text;
    return p;
  };

  function mountFeed() {
    wrapper = doc.createElement('div');
    wrapper.className = 'relative flex min-h-0 flex-1 flex-col';
    feed = doc.createElement('div');
    feed.setAttribute('data-testid', 'subtitle-feed');
    feed.setAttribute('aria-live', 'polite');
    feed.className = 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain';
    list = doc.createElement('div');
    list.className = 'flex flex-col gap-3 px-4 py-4';
    feed.append(list);
    button = doc.createElement('button');
    button.type = 'button';
    button.className = 'btn-primary absolute bottom-4 left-1/2 h-10 rounded-full px-5 shadow-pop';
    button.textContent = 'Jump to latest';
    button.hidden = true;
    const currentFeed = feed;
    const currentButton = button;
    button.addEventListener('click', () => {
      currentFeed.scrollTop = currentFeed.scrollHeight;
      currentButton.hidden = true;
    });
    feed.addEventListener('scroll', () => {
      currentButton.hidden = atBottom(currentFeed);
    });
    wrapper.append(feed, button);
    root.replaceChildren(wrapper);
  }

  const mock: MockAbestar = {
    setInterim(text) {
      if (!list || !feed) return;
      const bottom = atBottom(feed);
      if (text === null) {
        interim?.parentElement?.remove();
        interim = null;
      } else if (interim) {
        (interim.firstChild as Text).data = text;
      } else {
        interim = doc.createElement('p');
        interim.setAttribute('data-testid', 'subtitle-interim');
        interim.setAttribute('data-seg-id', 'interim');
        style(interim, 'draft');
        interim.append(doc.createTextNode(text));
        const div = card(interim);
        div.setAttribute('aria-hidden', 'true');
        list.append(div);
      }
      stick(feed, bottom);
    },

    addLine(line) {
      if (!list || !feed) return;
      const bottom = atBottom(feed);
      const p = lineElement(line);
      lines.set(line.seq, { line: { ...line }, p });
      const div = card(p);
      if (interim?.parentElement) list.insertBefore(div, interim.parentElement);
      else list.append(div);
      stick(feed, bottom);
    },

    updateLine(seq, status, text) {
      const entry = lines.get(seq);
      if (!entry) throw new Error(`no line ${seq}`);
      entry.line.status = status;
      entry.line.text = text;
      style(entry.p, status);
      entry.p.textContent = text;
    },

    lines: () => Array.from(lines.values(), (e) => ({ ...e.line })),

    remountFeed() {
      mountFeed();
      const current = Array.from(lines.values(), (e) => e.line);
      lines.clear();
      interim = null;
      for (const line of current) mock.addLine(line);
    },

    enter() {
      mountFeed();
      later(historyDelayMs, () => {
        for (const line of history) mock.addLine(line);
      });
    },

    play(steps) {
      for (const step of steps) {
        later(step.at, () => {
          if (step.action === 'interim') mock.setInterim(step.text);
          else if (step.action === 'add') mock.addLine(step);
          else mock.updateLine(step.seq, step.status, step.text);
        });
      }
    },

    stop() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
  };

  if (picker) {
    const select = doc.createElement('select');
    select.setAttribute('data-testid', 'target-lang-select');
    const enter = doc.createElement('button');
    enter.id = 'enter-event';
    enter.textContent = 'Enter event';
    enter.addEventListener('click', () => mock.enter());
    root.replaceChildren(select, enter);
  } else {
    mock.enter();
  }
  return mock;
}
