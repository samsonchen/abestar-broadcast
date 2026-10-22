// Records raw MutationObserver records on the translation column in the format of
// fixtures/logs/raw-session-*.json (PLAN.md §2.5).
//
// To record a new log on the real Abestar page, bundle it for the DevTools console:
//   npx esbuild fixtures/raw-logger.ts --format=iife --global-name=rawLogger
// paste the output into the console, then:
//   const log = rawLogger.startRawLogger(document.querySelector('[data-testid="col-right"]'));
//   …speak…
//   log.stop(); copy(JSON.stringify(log.records));

export interface RawRecord {
  /** `performance.now()` when the observer callback ran. */
  t: number;
  type: MutationRecordType;
  /** Index of the card that owns the target element; -1 for the list itself and for text nodes. */
  idx: number;
  /** Target's textContent, truncated to 120 chars. */
  text: string;
  /** Target's outerHTML, truncated to 300 chars; absent for text nodes. */
  html?: string;
}

const CARD = '[data-testid^="translation-"]:not([data-testid^="translation-dots"])';

export function startRawLogger(column: Element): { records: RawRecord[]; stop(): void } {
  const records: RawRecord[] = [];
  const observer = new MutationObserver((mutations) => {
    const t = performance.now();
    const cards = Array.from(column.querySelectorAll(CARD));
    for (const m of mutations) {
      const el = m.target.nodeType === Node.ELEMENT_NODE ? (m.target as Element) : null;
      const card = el?.closest(CARD);
      const record: RawRecord = {
        t,
        type: m.type,
        idx: card ? cards.indexOf(card) : -1,
        text: (m.target.textContent ?? '').slice(0, 120),
      };
      if (el) record.html = el.outerHTML.slice(0, 300);
      records.push(record);
    }
  });
  observer.observe(column, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  return { records, stop: () => observer.disconnect() };
}
