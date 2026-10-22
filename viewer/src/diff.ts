// Word-level marks for a revised line (PLAN.md §5.3): words added or changed since the previous text.
import { diffWords } from 'diff';

export interface Part {
  text: string;
  revised: boolean;
}

/** Splits `text` into runs, marking what is new relative to `prevText`. Removed words are dropped. */
export function revisionParts(prevText: string | null, text: string, lang?: string | null): Part[] {
  if (prevText === null || prevText === text) return [{ text, revised: false }];
  // Intl.Segmenter finds word boundaries in languages without spaces (Chinese, Japanese).
  const intlSegmenter =
    typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(lang ?? undefined, { granularity: 'word' })
      : undefined;
  const parts: Part[] = [];
  for (const change of diffWords(prevText, text, { intlSegmenter })) {
    if (change.removed) continue;
    const revised = change.added && change.value.trim() !== '';
    const last = parts.at(-1);
    if (last && last.revised === revised) last.text += change.value;
    else parts.push({ text: change.value, revised });
  }
  return parts;
}
