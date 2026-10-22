// Turns DOM changes in Abestar's translation column into CaptureMessages (PLAN.md §4.3).
// Pure DOM logic: content/index.ts connects it to the background worker.

import type { CaptureMessage } from '@abestar/shared';
import { CARD, CARD_TESTID, CARD_TEXT, PLACEHOLDER, TRANSLATION_COLUMN } from './selectors';

export interface CaptureOptions {
  /** Send the cards already on the page when capture starts; otherwise only later changes are sent. */
  includeExisting?: boolean;
  /** Quiet time after a card's last mutation before it is read. */
  debounceMs?: number;
  /** How long to wait for the column before reporting `column-not-found`. */
  columnTimeoutMs?: number;
}

export interface Capture {
  stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

const ELEMENT_NODE = 1;
const OBSERVE: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
};

export function startCapture(
  doc: Document,
  send: (message: CaptureMessage) => void,
  { includeExisting = false, debounceMs = 400, columnTimeoutMs = 10_000 }: CaptureOptions = {},
): Capture {
  /** Text last sent per card number, for this epoch. */
  const lastSent = new Map<number, string>();
  /** Card elements in the column after the last change. */
  let present = new Set<Element>();
  let maxSeq = 0;
  const timers = new Map<Element, Timer>();
  let column: Element | null = null;
  let firstAttach = true;
  let notFoundTimer: Timer | undefined;

  const seqOf = (card: Element): number | null => {
    const match = CARD_TESTID.exec(card.getAttribute('data-testid') ?? '');
    return match ? Number(match[1]) : null;
  };
  const cardsIn = (root: ParentNode) =>
    Array.from(root.querySelectorAll(CARD)).filter((card) => seqOf(card) !== null);
  const textOf = (card: Element) => card.querySelector(CARD_TEXT)?.textContent?.trim() ?? '';

  function read(card: Element) {
    timers.delete(card);
    const seq = seqOf(card);
    if (seq === null || !card.isConnected || card.querySelector(PLACEHOLDER)) return;
    const text = textOf(card);
    if (!text || lastSent.get(seq) === text) return;
    lastSent.set(seq, text);
    send({ kind: 'segment', seq, text, lang: card.getAttribute('lang') });
  }

  function schedule(card: Element) {
    clearTimeout(timers.get(card));
    timers.set(
      card,
      setTimeout(() => read(card), debounceMs),
    );
  }

  function reset(reason: 'load' | 'clear') {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    lastSent.clear();
    maxSeq = 0;
    send({ kind: 'reset', reason });
  }

  /**
   * Detects the broom / a new presentation. Within one column React keeps card elements, so a restart
   * is: every previous card element is gone and numbering is back at or below the old maximum (an empty
   * column counts). A remounted column has all-new elements; there, it is a restart only if no finished
   * card still shows text we sent.
   */
  function track(cards: Element[], remounted = false) {
    const seqs = cards.map(seqOf).filter((seq) => seq !== null);
    let restarted: boolean;
    if (remounted) {
      const finished = cards.filter((card) => !card.querySelector(PLACEHOLDER) && textOf(card));
      restarted =
        lastSent.size > 0 &&
        finished.length > 0 &&
        !finished.some((card) => lastSent.get(seqOf(card) ?? -1) === textOf(card));
    } else {
      restarted =
        present.size > 0 &&
        !Array.from(present).some((card) => card.isConnected) &&
        (seqs.length === 0 || Math.min(...seqs) <= maxSeq);
    }
    if (restarted) reset('clear');
    present = new Set(cards);
    for (const seq of seqs) maxSeq = Math.max(maxSeq, seq);
  }

  const columnObserver = new MutationObserver((mutations) => {
    if (!column) return;
    const touched = new Set<Element>();
    for (const m of mutations) {
      const node =
        m.target.nodeType === ELEMENT_NODE ? (m.target as Element) : m.target.parentElement;
      const card = node?.closest(CARD);
      if (card) touched.add(card);
      for (const added of Array.from(m.addedNodes)) {
        if (added.nodeType !== ELEMENT_NODE) continue;
        const el = added as Element;
        if (el.matches(CARD)) touched.add(el);
        for (const inner of cardsIn(el)) touched.add(inner);
      }
    }
    track(cardsIn(column));
    for (const card of touched) if (card.isConnected) schedule(card);
  });

  function waitForColumn() {
    clearTimeout(notFoundTimer);
    notFoundTimer = setTimeout(
      () => send({ kind: 'status', status: 'column-not-found' }),
      columnTimeoutMs,
    );
  }

  function attach(found: Element) {
    column = found;
    clearTimeout(notFoundTimer);
    send({ kind: 'status', status: 'ok' });
    const cards = cardsIn(found);
    track(cards, !firstAttach);
    if (firstAttach && !includeExisting) {
      // Start mid-talk: what is already on screen counts as sent.
      for (const card of cards) {
        const seq = seqOf(card);
        const text = textOf(card);
        if (seq !== null && text && !card.querySelector(PLACEHOLDER)) lastSent.set(seq, text);
      }
    } else {
      // Backfill, or a React remount: unchanged texts are dropped by lastSent.
      for (const card of cards) schedule(card);
    }
    firstAttach = false;
    columnObserver.observe(found, OBSERVE);
  }

  function detach() {
    columnObserver.disconnect();
    column = null;
    send({ kind: 'status', status: 'detached' });
    waitForColumn();
  }

  // React may unmount and remount the column; follow it.
  const pageObserver = new MutationObserver(() => {
    if (column && !column.isConnected) detach();
    if (!column) {
      const found = doc.querySelector(TRANSLATION_COLUMN);
      if (found) attach(found);
    }
  });

  send({ kind: 'reset', reason: 'load' });
  pageObserver.observe(doc, { subtree: true, childList: true });
  const initial = doc.querySelector(TRANSLATION_COLUMN);
  if (initial) attach(initial);
  else waitForColumn();

  return {
    stop() {
      pageObserver.disconnect();
      columnObserver.disconnect();
      clearTimeout(notFoundTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
