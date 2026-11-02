// Every Abestar DOM selector lives here and nowhere else.
// Verified against the live page on 2026-11-02; see fixtures/logs/v2-session-1.json and v2-page-excerpt.html.

/** The scrollable list of lines. Appears only after the language picker. */
export const FEED = '[data-testid="subtitle-feed"]';

/** A received line. The line still being spoken is `subtitle-interim`, which is not captured. */
export const LINE = '[data-testid="subtitle-line"]';

/** `data-status` of a final line: its text never changes again. */
export const CORRECTED = 'corrected';

/** "Jump to latest", shown only while scrolled back. It has no test ID and its label is translated. */
export const JUMP_BUTTON = '[data-testid="subtitle-feed"] ~ button';

/** `data-seg-id` → sequence number N, e.g. `mvy16ds3-19`. */
export const SEG_ID = /-(\d+)$/;
