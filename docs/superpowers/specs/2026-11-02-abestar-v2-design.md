# Abestar v2 extension: design

Written 2026-11-02. Status: approved and implemented. Overrides `PLAN.md` and `docs/tts-plan.md` where they differ (v1's
R4, one line behind, stays in force for v1 sessions only).

## Goal

Rebroadcast the translation from Abestar v2 (`live.abestar.com.tw`) to the existing viewer. Viewers and read-aloud get
final lines only, and read-aloud has no line delay. The v1 extension stays installed and keeps working.

## Owner decisions

| #   | Decision                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Capture only final lines. Read-aloud speaks a line as soon as it arrives.                                                                                                                                           |
| D2  | `main` becomes v2 only. v1 is rebuilt from the `abestar_v1` tag if ever needed. The database stays compatible with the installed v1 extension.                                                                      |
| D3  | While broadcasting, 3 s after the last scroll, a scrolled-back page jumps to the latest line.                                                                                                                       |
| D4  | A line still in draft after 10 s is sent as it is. If it is corrected later, the text updates on phones and is not spoken again.                                                                                    |
| D5  | ElevenLabs loses the next line as an intonation hint in v2 sessions. Accepted.                                                                                                                                      |
| D6  | The new recorded log is committed in full.                                                                                                                                                                          |
| D7  | A broadcast ends when the tab is closed, End broadcast is pressed, or Chrome is closed. A presenter stopping and restarting in Abestar does nothing to the page or the broadcast, so there is no restart detection. |

## Evidence

From the live event AJM-0256 on 2026-11-02: 68 lines from one session, about 6 minutes, plus the owner's screen
recording.

The page is a Next.js app that receives lines over socket.io. `/j/<code>` moves to `/listen/<code>` by client-side
navigation, without a full page load. A language picker (`target-lang-select`, "Enter event") comes first, and the feed
appears only after it.

```html
<div class="relative flex ...">
  <div data-testid="subtitle-feed" aria-live="polite" class="... overflow-y-auto ...">
    <div class="flex flex-col gap-3 ...">
      <div class="rounded-card ...">
        <p
          data-testid="subtitle-line"
          data-seg-id="mvy16ds3-19"
          data-status="corrected"
          data-lang="en"
          lang="en"
        >
          …
        </p>
      </div>
      <div aria-hidden="true" class="rounded-card ...">
        <p data-testid="subtitle-interim" data-seg-id="interim" data-status="draft">…</p>
      </div>
    </div>
  </div>
  <button class="btn-primary absolute ...">Jump to latest</button>
  <!-- only while scrolled back -->
</div>
```

| Observation                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle: `subtitle-interim` → `subtitle-line` with `data-status="draft"` → `data-status="corrected"`.                                                             |
| The text is rewritten at the step to `corrected`, so draft text is not the final text.                                                                              |
| Draft to corrected took 0.4–2.1 s over 21 timed lines. Some lines are added already `corrected`.                                                                    |
| No corrected line changed afterwards. Every line reached `corrected`.                                                                                               |
| Lines became final in order, numbers ran 1–68 without gaps, and no line was removed.                                                                                |
| After 30 s offline, the 5 missed lines were added at once as `corrected`.                                                                                           |
| A language switch changes new lines only; older lines keep their text and language.                                                                                 |
| Lines keep arriving while the page is scrolled back, so capture does not depend on scrolling.                                                                       |
| The jump button has no test ID and its label is translated. Clicking it, or setting `scrollTop` to the bottom, returns to the bottom and the page then stays there. |

**Hidden tab (GEF-5901, 2026-11-02):** in a truly hidden tab with Chrome's background throttling on, 92 lines over 11 minutes went from draft to corrected in 0.1–2.5 s, 56 of them after the first 5 minutes, and the feed stayed at the bottom. The longest gap between lines was 53 s, which is taken to be a pause in speech. Page timers were throttled to as little as once a minute, so the 3 s and 10 s timers can run late there. The background-tab workaround from v1 is removed.

The evidence is otherwise one session, so D4 exists as a safety net.

## Capture

`extension/src/content/capture.ts` is rewritten and keeps its shape: `startCapture(doc, send, options)`, dependencies
as arguments, no `chrome.*`. Selectors stay in `selectors.ts`:

```ts
export const FEED = '[data-testid="subtitle-feed"]';
export const LINE = '[data-testid="subtitle-line"]';
export const JUMP_BUTTON = '[data-testid="subtitle-feed"] ~ button';
export const SEG_ID = /-(\d+)$/; // data-seg-id → sequence number
```

Rules, for each `subtitle-line`:

1. `seq` is the trailing number of `data-seg-id`. A line without one is ignored. `subtitle-interim` is ignored.
2. `seq` at or below the baseline is ignored, except rule 5's correction.
3. On `data-status="corrected"`: send it with its text and `lang`, once. A corrected line is not read or sent again.
4. On first seeing a draft: start a 10 s timer (`draftTimeoutMs`). If it is still a draft when the timer fires, send
   its current text.
5. A line sent by rule 4 that later turns `corrected` is sent once more with the corrected text.

Any other `data-status` value is treated like a draft, so an unknown new status is delayed by 10 s rather than lost.

**Baseline.** The line number at or below which lines are not sent.

- **After a reload of the broadcasting tab:** the highest `seq` the worker knows (`lastSeq`), so lines that appeared
  during the reload are recovered.
- **At broadcast start:** the highest `seq` already `corrected` on screen. Drafts on screen are still pending and get
  sent. The content script reports this with a `baseline` capture message, so the worker has `lastSeq` even before the
  first line, and a reload then does not re-send the history.
- **Feed still empty at start:** on the live page, the feed appears empty and its whole history arrives about 70 ms
  later in one batch. So if the feed is empty, the baseline is taken at the first batch of lines, or set to 0 if none
  arrive within 5 s (`historyWindowMs`).

A new draft that comes first means every line before it is history, so the baseline is at least one below the lowest
draft, even if those lines have not arrived yet. After the 5 s window, a first batch with more than one final line
still counts as history: live lines come one at a time.

Lines added late after a dropped connection are above the baseline and are sent normally.

**Another event in the same tab.** Another event's lines are numbered from 1 again, so a broadcast that stays on the old
baseline would drop them while the popup still says Live. The event code from the URL (`/j/<code>`, `/listen/<code>`)
goes to the worker with `hello` and an `event` capture message. When it changes, the broadcast continues in a new epoch
with a new baseline, as with a new broadcast, and phones keep the old event's lines above the new ones.

**Removed.** The debounce (and its options field, `DEFAULT_DEBOUNCE_MS`, and the `debounceMs` message fields), the
`clear` reset and its detection. The epoch changes only when the tab moves to another event: a reload resumes on the same numbers,
and `upsert_segment`'s existing behavior makes any repeat harmless.

**Waiting for the feed.** The feed does not exist on the language picker, and React may remount it, so the page
observer that follows the column stays. The existing 10 s `column-not-found` status remains, with the popup text
changed to say to choose a language and press Enter event.

## Background worker

`broadcaster.ts` changes little:

- `Broadcast` gets `lastSeq: number | null`, raised by `segment` and `baseline` capture messages and saved with the
  rest of the state.
- `hello` replies with `{ capture: true, resumeAfterSeq: lastSeq }`. `start` carries no baseline, so the content script
  takes it from the page.
- The `reset` capture message is removed and a `baseline` one added.
- `start_session` is called with `p_tts_release: 'final'`.

Ending a broadcast is unchanged, covering D7: `tabClosed`, the End button, and `endLeftover`. When Chrome is closed the
extension cannot call the server, so the session ends the next time Chrome starts, or by the existing 2-hour idle
auto-end if it is not reopened. Phones show the session as live until then.

## Staying at the latest line

`extension/src/content/follow.ts` is rewritten, and takes `doc` and the delay as arguments for unit tests.

While broadcasting, a 500 ms timer checks the feed. If the feed is more than 2 px from the bottom and has had no
`scroll` event for 3 s, it clicks `JUMP_BUTTON`. If the button is not found, it sets `feed.scrollTop = feed.scrollHeight`.
This applies with or without tab focus. A timer is used instead of reacting to scroll events alone because a tab that
falls behind without any scrolling, such as a background tab, fires no scroll event. `scroll` is listened for on the
document in the capture phase, so a remounted feed needs no new listener. `follow.stop()` cancels everything.

## Read-aloud

New migration `supabase/migrations/0007_tts_release.sql`:

- `public.sessions.tts_release text not null default 'next_line' check (tts_release in ('next_line', 'final'))`.
- `start_session` is recreated with `p_tts_release text default 'next_line'`, with its grants restored. The installed v1
  extension does not send the new parameter, so it keeps today's behavior.
- `private.segments_tts_release()`: for a `final` session, an insert enqueues the new line itself; a `next_line` session
  is unchanged. Updates still do nothing, so a late correction (D4) is not spoken again.
- `private.tts_flush()`: skips `final` sessions, which have nothing waiting.
- `private.tts_jobs.released_by` also allows `'final'`.

The viewer is unchanged. Two existing behaviors matter:

- `AudioQueue` keeps at most 2 waiting lines, so after a reconnect older missed lines may appear as text without being
  spoken.
- `AudioQueue` never goes back, so a line sent late by D4 after a newer line has played is shown but not spoken.

The migration must be applied to the hosted project before v2's first broadcast. It is safe to apply while v1 is in
use. The owner applies it, as with earlier migrations.

## Packaging and running beside v1

`extension/build.mjs`:

| Field            | v2                                                                           |
| ---------------- | ---------------------------------------------------------------------------- |
| Name             | `Abestar Broadcast v2`                                                       |
| Version          | `0.3.0`                                                                      |
| Output           | `dist/v2` (local: `dist/v2-local`), zip `abestar-broadcast-v2-0.3.0.zip`     |
| Content scripts  | `https://live.abestar.com.tw/j/*` and `https://live.abestar.com.tw/listen/*` |
| Host permissions | `https://live.abestar.com.tw/*` and the Supabase URL                         |

Both `/j/*` and `/listen/*` are needed because of the client-side navigation.

Side by side: the two load from different folders, so Chrome gives them different IDs and separate settings. The
broadcast token is entered once in v2. They match different pages. The server allows one live session at a time, so
starting one while the other is live gives the existing "session already live" prompt.

Removed from `main` (kept at the tag): v1 selectors and capture, the v1 mock and logs, and
`content/frames.ts` + `main-world.ts` + `signals.ts`, which the hidden-tab test showed v2 does not need.

## Testing

- **Recorded log:** record a new raw log from the live page into `fixtures/logs/` and update `fixtures/raw-logger.ts`
  and `log-digest.ts` for the new selectors.
- **Mock:** `fixtures/mock-abestar.ts` and `.html` rebuilt on the v2 DOM (picker, feed, interim, draft, corrected, jump
  button, late batch). `mock-fidelity.test.ts` guards it against the new log.
- **Unit (`capture.test.ts`):** sends on corrected only; never sends interim; line added already corrected; start
  baseline with a pending draft; draft timeout then correction; unknown status; late batch; reload resume; no send after
  stop; feed remount; empty feed then history batch; empty feed with no history.
- **Unit (`follow.test.ts`):** timer restart on scroll, click, fallback without the button, cancel at the bottom, stop.
- **Unit (`broadcaster.test.ts`):** `lastSeq` saved and returned by `hello`, `p_tts_release` passed.
- **pgTAP and integration:** `final` session enqueues on insert and not again on update; flush skips it; `next_line`
  session unchanged; `start_session` called with v1's arguments gets `next_line`.
- **e2e:** existing Playwright specs moved to the v2 mock, including the jump.
- **Hidden tab (manual, headed browser):** with the live page in a background tab, confirm lines still reach
  `corrected` and are captured in time. Decides whether the frames workaround is removed. If timers are throttled, the
  3 s and 10 s timers may fire late, which is acceptable.
- **Owner's real run:** live Abestar v2 with read-aloud on, v1 still installed.

## Documentation

`CLAUDE.md` (commands, selectors, the v1 tag), `README.md`, and a note in `docs/tts-plan.md` that R4 applies to v1
sessions only.

## Out of scope

Changes to the viewer, capturing several languages at once, sending lines from before the broadcast started, and new
v1 features.
