// Turns Abestar's subtitle feed into CaptureMessages. Pure DOM logic: content/index.ts connects it to the worker.
// A line is sent once, when it is final. See docs/superpowers/specs/2026-11-02-abestar-v2-design.md.

import type { CaptureMessage } from '@abestar/shared';
import { CORRECTED, EVENT_PATH, FEED, LINE, SEG_ID } from './selectors';

export const eventCode = (doc: Document): string | null =>
  EVENT_PATH.exec(doc.location.pathname)?.[1] ?? null;

export interface CaptureOptions {
  /** After a reload: lines up to here were already sent. Null: this is a new broadcast, take it from the page. */
  resumeAfterSeq?: number | null;
  /** A line still not final after this long is sent as it is. */
  draftTimeoutMs?: number;
  /** How long an empty feed may wait for its history before counting as an event with none. */
  historyWindowMs?: number;
  /** How long to wait for the feed before reporting `column-not-found`. */
  feedTimeoutMs?: number;
}

export interface Capture {
  stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

const OBSERVE: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['data-status'],
};

export function startCapture(
  doc: Document,
  send: (message: CaptureMessage) => void,
  {
    resumeAfterSeq = null,
    draftTimeoutMs = 10_000,
    historyWindowMs = 5_000,
    feedTimeoutMs = 10_000,
  }: CaptureOptions = {},
): Capture {
  /** Lines at or below this are not sent. Null until known. */
  let baseline = resumeAfterSeq;
  /** Lines sent with their final text. */
  const finished = new Set<number>();
  /** Lines sent by the draft timeout, which may still be corrected. */
  const sentAsDraft = new Set<number>();
  const draftTimers = new Map<number, Timer>();
  let feed: Element | null = null;
  let notFoundTimer: Timer | undefined;
  let historyTimer: Timer | undefined;
  /** No lines seen yet, with the baseline already at 0: a batch may still be the history, just slow to arrive. */
  let historyMayBeLate = resumeAfterSeq === 0;
  let event = eventCode(doc);
  /** The previous event's feed, which may stay on screen for a moment after the URL changes. */
  let retiredFeed: Element | null = null;

  const seqOf = (line: Element): number | null => {
    const match = SEG_ID.exec(line.getAttribute('data-seg-id') ?? '');
    return match ? Number(match[1]) : null;
  };
  const textOf = (line: Element) => line.textContent?.trim() ?? '';
  const isFinal = (line: Element) => line.getAttribute('data-status') === CORRECTED;
  const linesIn = (root: ParentNode) => Array.from(root.querySelectorAll(LINE));

  const sendLine = (line: Element, seq: number, text: string) =>
    send({ kind: 'segment', seq, text, lang: line.getAttribute('lang') });

  function draftTimedOut(seq: number) {
    draftTimers.delete(seq);
    if (!feed) return;
    const line = linesIn(feed).find((el) => seqOf(el) === seq);
    const text = line ? textOf(line) : '';
    if (!line || !text || isFinal(line)) return;
    sentAsDraft.add(seq);
    sendLine(line, seq, text);
  }

  function scan() {
    if (!feed || baseline === null) return;
    for (const line of linesIn(feed)) {
      const seq = seqOf(line);
      if (seq === null || seq <= baseline || finished.has(seq)) continue;
      const text = textOf(line);
      if (isFinal(line)) {
        if (!text) continue;
        clearTimeout(draftTimers.get(seq));
        draftTimers.delete(seq);
        finished.add(seq);
        sendLine(line, seq, text);
      } else if (!draftTimers.has(seq) && !sentAsDraft.has(seq)) {
        draftTimers.set(
          seq,
          setTimeout(() => draftTimedOut(seq), draftTimeoutMs),
        );
      }
    }
  }

  /**
   * Whatever is final on screen now is history. Drafts are still to come, and lines before the first draft are
   * history even if they have not arrived yet.
   */
  function takeBaseline() {
    clearTimeout(historyTimer);
    historyTimer = undefined;
    if (!feed) return; // replaced during the window: attach() arms the timer again
    const lines = linesIn(feed);
    const seqs = (list: Element[]) => list.map(seqOf).filter((seq) => seq !== null);
    const drafts = seqs(lines.filter((line) => !isFinal(line)));
    historyMayBeLate = lines.length === 0;
    baseline = Math.max(
      0,
      ...seqs(lines.filter(isFinal)),
      ...(drafts.length > 0 ? [Math.min(...drafts) - 1] : []),
    );
    send({ kind: 'baseline', seq: baseline });
    scan();
  }

  function linesChanged() {
    if (!feed) return;
    const lines = linesIn(feed);
    if (baseline === null) {
      if (lines.length > 0) takeBaseline();
      return;
    }
    if (historyMayBeLate && lines.length > 0) {
      historyMayBeLate = false;
      // Live lines come one at a time; several final ones at once, with nothing before them, are the history.
      if (lines.filter(isFinal).length > 1) return takeBaseline();
    }
    scan();
  }

  const feedObserver = new MutationObserver(() => {
    checkEvent();
    linesChanged(); // nothing to do if the event just changed: the feed is gone
  });

  function waitForFeed() {
    clearTimeout(notFoundTimer);
    notFoundTimer = setTimeout(
      () => send({ kind: 'status', status: 'column-not-found' }),
      feedTimeoutMs,
    );
  }

  function attach(found: Element) {
    feed = found;
    clearTimeout(notFoundTimer);
    send({ kind: 'status', status: 'ok' });
    feedObserver.observe(found, OBSERVE);
    linesChanged();
    if (baseline === null) historyTimer ??= setTimeout(takeBaseline, historyWindowMs);
  }

  function detach() {
    feedObserver.disconnect();
    feed = null;
    send({ kind: 'status', status: 'detached' });
    waitForFeed();
  }

  /** Another event's lines are numbered from 1 again, so nothing known about this one carries over. */
  function movedTo(code: string) {
    event = code;
    send({ kind: 'event', code });
    feedObserver.disconnect();
    retiredFeed = feed;
    feed = null;
    baseline = null;
    historyMayBeLate = false;
    finished.clear();
    sentAsDraft.clear();
    for (const timer of draftTimers.values()) clearTimeout(timer);
    draftTimers.clear();
    clearTimeout(historyTimer);
    historyTimer = undefined;
    waitForFeed();
  }

  function checkEvent() {
    const code = eventCode(doc);
    if (code && code !== event) movedTo(code);
  }

  // The feed appears after the language picker, and React may replace it.
  const pageObserver = new MutationObserver(() => {
    checkEvent();
    if (feed && !feed.isConnected) detach();
    if (!feed) {
      const found = doc.querySelector(FEED);
      if (found && found !== retiredFeed) attach(found);
    }
  });
  if (event) send({ kind: 'event', code: event });
  pageObserver.observe(doc, { subtree: true, childList: true });
  const initial = doc.querySelector(FEED);
  if (initial) attach(initial);
  else waitForFeed();

  return {
    stop() {
      pageObserver.disconnect();
      feedObserver.disconnect();
      clearTimeout(notFoundTimer);
      clearTimeout(historyTimer);
      for (const timer of draftTimers.values()) clearTimeout(timer);
      draftTimers.clear();
    },
  };
}
