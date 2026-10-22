// Every Abestar DOM selector lives here and nowhere else (PLAN.md §4.3, §9).
// Verified against the live page on 2026-10-22; see fixtures/logs/raw-session-1.json.

/** The scrollable translation column. */
export const TRANSLATION_COLUMN = '[data-testid="col-right"]';

/** A translation card, finished or pending (excludes the dots `<p>` inside a pending card). */
export const CARD = '[data-testid^="translation-"]:not([data-testid^="translation-dots"])';

/** Present inside a card while it is still a placeholder. */
export const PLACEHOLDER = '[data-testid^="translation-dots"]';

/** The text paragraph of a finished card. */
export const CARD_TEXT = 'p:not([data-testid])';

/** Card testid → sequence number N. */
export const CARD_TESTID = /^translation-(\d+)$/;
