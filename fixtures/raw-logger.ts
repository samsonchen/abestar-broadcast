// Records the life of every subtitle line in the format of fixtures/logs/v2-session-*.json.
//
// To record a new log on the real Abestar page, bundle it for the DevTools console:
//   npx esbuild fixtures/raw-logger.ts --format=iife --global-name=rawLogger
// paste the output into the console, then:
//   const log = rawLogger.startRawLogger(document.body);
//   …speak…
//   log.stop(); copy(JSON.stringify(log.records));

export interface RawRecord {
  /** ms since the logger started. */
  t: number;
  ev: 'add' | 'change' | 'gone' | 'MARK';
  /** `data-seg-id`, or `interim`. */
  id?: string;
  tid?: string;
  st?: string | null;
  lang?: string | null;
  text?: string;
  /** Only on MARK: what the recording did at this moment (scroll-up, offline, online, lang-ja, lang-en, end). */
  m?: string;
}

const LINE = '[data-testid="subtitle-line"],[data-testid="subtitle-interim"]';

export function startRawLogger(root: Element): { records: RawRecord[]; stop(): void } {
  const records: RawRecord[] = [];
  const t0 = performance.now();
  const last = new Map<string, string>();

  const scan = () => {
    const t = Math.round(performance.now() - t0);
    const seen = new Set<string>();
    for (const el of Array.from(root.querySelectorAll(LINE))) {
      const line = {
        id: el.getAttribute('data-seg-id') ?? '',
        tid: el.getAttribute('data-testid') ?? '',
        st: el.getAttribute('data-status'),
        lang: el.getAttribute('data-lang') ?? el.getAttribute('lang'),
        text: el.textContent ?? '',
      };
      seen.add(line.id);
      const key = JSON.stringify(line);
      if (last.get(line.id) === key) continue;
      records.push({ t, ev: last.has(line.id) ? 'change' : 'add', ...line });
      last.set(line.id, key);
    }
    for (const id of Array.from(last.keys())) {
      if (seen.has(id)) continue;
      records.push({ t, ev: 'gone', id });
      last.delete(id);
    }
  };

  scan();
  const observer = new MutationObserver(scan);
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-status', 'data-lang', 'data-seg-id'],
  });
  return { records, stop: () => observer.disconnect() };
}
