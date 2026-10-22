# Abestar Translation Broadcast — Project Plan

> Hand-off plan for Claude Code. Read this whole file before writing code.
> Three sub-projects in one monorepo: **extension/** (Chrome MV3), **viewer/** (GitHub Pages), **supabase/** (backend).
> All code in **TypeScript**. Nothing has been built yet; no Supabase project exists yet.

---

## 0. Owner decisions (review session 2026-10-22)

These override anything below that disagrees.

| Topic | Decision |
|---|---|
| Audience | ≤ 40 concurrent viewers. Postgres Changes on the free plan is enough; Broadcast-from-DB stays optional (M6). |
| Region | `us-west-2` (~150 ms RTT from Taiwan; acceptable). |
| Broadcaster | Exactly one broadcaster at a time, but anyone with the extension may be it. Auth is a **broadcast token** (long random secret, never expires, only its hash stored). No broadcaster Supabase user, no email/password. No rotation feature; the guide documents a manual replacement if it leaks. |
| One live session | Starting a broadcast while another is live **auto-ends the old one** after a confirm dialog. Server auto-ends a session after **2 h** with no activity; viewer shows "No new lines" after 10 min idle. |
| Audience access | One fixed viewer URL. Each broadcast gets a fresh random **6-digit PIN**, shown in the extension; the extension's link/QR carry `?pin=`. No PIN in the URL → viewer shows a PIN dialog. Enforced server-side (anonymous sign-in + `join_session(pin)` + RLS), rate-limited. Sessions are unlisted; no "latest live session" fallback. |
| After end | **When it ends, it ends.** No new joins and no reads after `status = 'ended'`; lines already on screen stay until reload. |
| Page reload | Presenter reloading Abestar continues the same session in a **new epoch** (epoch owned by the background worker, persisted). |
| Viewer UI | English only. Repo is public; viewer on GitHub Pages. |
| Extension distribution | Private zip, loaded unpacked. Supabase URL + publishable key baked in at build; token pasted once in options. |
| Supabase setup | Done by CLI where possible: owner runs `supabase login` then `scripts/supabase-setup.sh`. `docs/supabase-setup.md` covers only the manual steps, verification and troubleshooting. |
| Local backend | Colima, started on demand (`colima start` / `colima stop`), not at login. Finch was tested and does **not** work with the Supabase CLI (missing `--network-alias`, container prune and `docker cp` support). CI uses GitHub's Docker. |
| Free-plan pausing | No keep-alive. The "before an event" checklist says to check the project status and restore it the day before. |

---

## 1. Goal

A presenter runs **Abestar GO!** ("Presentation and Meeting Translation", currently at
`https://testgo.abestar.com.tw/presentation/language?deviceId=…`) in Chrome. It shows live speech
transcription (left column, e.g. zh-TW) and machine translation (right column, e.g. en-US).

We want to **rebroadcast the translation column only** to an audience:

```
Abestar page ──(content script reads DOM)──► Chrome extension ──(HTTPS)──► Supabase
                                                                              │ Realtime
                                              audience phones / laptops ◄─────┘
                                              (static viewer on GitHub Pages)
```

- Audience members open one URL (usually from a QR code that includes the session PIN) on their phones and see the translation live.
- Many viewers at once (broadcast, one writer → N readers).
- Desktop browsers must also work.

### Non-goals (v1)
- Not broadcasting the source (speaker) column.
- No audio, no re-translation, no editing of text.
- No changes to Abestar itself; we only read its DOM.

---

## 2. What we already know about the Abestar page (verified 2026-10-22)

Investigated with a live page, three DevTools MutationObserver logs, and a screen recording.

### 2.1 Tech
- React SPA + Tailwind. Talks to its own backend over Socket.IO (`/socket.io/?EIO=4`). No iframes, no shadow DOM.
- **We deliberately do NOT hook the Socket.IO protocol** (undocumented, can change any deploy). DOM only.

### 2.2 DOM structure of the translation column
```html
<div data-testid="col-right" class="min-h-0 flex-1 overflow-y-auto">
  <div class="flex flex-col gap-3 px-3">
    <!-- finished card -->
    <div lang="en-US" data-testid="translation-1" class="relative rounded-lg p-2 xl:p-4 shadow-md bg-slate-50">
      <svg class="lucide lucide-check-check absolute top-0.5 right-1 w-3 h-3 text-amber-500">…</svg>
      <p class="text-lg font-medium text-gray-700">Chinese test, testing translation.</p>
    </div>
    <!-- pending card: placeholder dots, cycles "." ".." "..." every 400 ms -->
    <div lang="en-US" data-testid="translation-2" class="…">
      <p data-testid="translation-dots-2" class="text-lg font-medium text-gray-700">..</p>
    </div>
    <div></div>
  </div>
</div>
```
Key facts:
- **Stable per-card ID:** `data-testid="translation-N"`, N = 1, 2, 3… in order. Use N as the segment sequence number.
- **Placeholder state:** card contains `<p data-testid="translation-dots-N">` — ignore until it is replaced.
- **Typing animation:** when the translation arrives, the full sentence is typed into the `<p>` at ~2 chars / 17 ms
  (a 95-char sentence takes ~0.6 s). It is NOT streaming from the server — it's cosmetic.
- **Check icon** (`lucide-check-check`, amber) arrives together with the text. It does not indicate a later "final" state.
- `lang` attribute on the card = target language (e.g. `en-US`). The column header also shows `(en-US)`.

### 2.3 Revisions
- The **source (left) column** revises its live draft line (ASR correction, e.g. 沈伯洋 → 陳時中) before confirming it.
- The **translation column is only produced after the source sentence is confirmed**, and in ~30 observed segments
  (incl. 20 s after pressing Stop) **no translation card ever changed after it settled**.
- Conclusion: translation segments are effectively write-once. We still implement revision handling as a
  cheap safety net (see §4.4 / §6.4) because the original requirement asks for it and Abestar may change.

### 2.4 Unknowns to keep in mind
- Whether N restarts at 1 after the broom (clear) button or a new "Start Presentation". Assume **yes**.
- Whether old cards are ever removed from the DOM in very long sessions (not observed). Design must not depend on old cards staying.
- Production hostname (we've only seen `testgo.abestar.com.tw`). Make host patterns configurable.

### 2.5 Recorded evidence: `fixtures/logs/raw-session-1.json`
Provided alongside this plan; commit it unchanged. It is a JSON array of 164 raw MutationObserver records captured on
the real Abestar page (4 translation cards), each `{t, type, idx, text, html?}`:
- `t`: ms timestamp (`performance.now()`); `type`: `childList` | `characterData` | `attributes`
- `text`: target's `textContent` (truncated to 120 chars); `html`: target's `outerHTML` (truncated to 300 chars)

It shows the exact sequence the capture code must handle: placeholder dots cycling (`.` `..` `...` every 400 ms),
card insertion with `data-testid="translation-N"`, the `<p>` being swapped from dots to an empty text paragraph, the
typing animation (~2 chars / 17 ms), and the next card's dots starting while the previous card is still typing.

Uses:
- **M0:** the reference for building `fixtures/mock-abestar.html`. The mock's timings and DOM shape must match this log.
- **M2:** a Vitest helper replays the log's timing against the mock DOM. The assertion is that the capture emits exactly
  4 events with these final texts: "Chinese test, testing translation.", "Come and check out the Furry Kid Market.",
  "Healthy and flexible for brisk walking, or enhanced maintenance for joint degeneration warnings.",
  "Pet joint health self-assessment form."
- **Regression:** after an Abestar update, record a new log with a similar raw logger, add it as `raw-session-N.json`, and re-run.

---

## 3. Repository layout

```
abestar-broadcast/
├── PLAN.md                     # this file
├── CLAUDE.md                   # short: conventions + commands (create in M0)
├── package.json                # npm workspaces: extension, viewer, shared
├── docs/
│   └── supabase-setup.md       # owner's manual steps + verification + troubleshooting (see §6.6)
├── scripts/
│   └── supabase-setup.sh       # CLI setup: create/link project, db push, config push, token, write config (see §6.6)
├── shared/                     # types shared by extension + viewer
│   └── src/types.ts            # Session, Segment, wire payloads
├── supabase/
│   ├── config.toml             # supabase CLI (local dev)
│   ├── migrations/
│   │   └── 0001_init.sql
│   └── seed.sql                # local-only test data
├── extension/
│   ├── manifest.json
│   ├── src/
│   │   ├── content/            # DOM capture (runs on Abestar page)
│   │   │   ├── selectors.ts    # ALL Abestar selectors live here, nowhere else
│   │   │   ├── capture.ts      # MutationObserver + debounce + diff
│   │   │   └── index.ts
│   │   ├── background/         # service worker: auth, queue, Supabase writes
│   │   ├── popup/              # start/stop broadcast, link + QR, status
│   │   └── options/            # Supabase URL/key, viewer base URL, host patterns
│   ├── build.mjs               # esbuild bundling
│   └── test/
├── viewer/
│   ├── index.html
│   ├── src/                    # vanilla TS, no framework
│   ├── public/config.js        # SUPABASE_URL + publishable key (public by design; written by setup script)
│   └── vite.config.ts          # base = '/<repo-name>/'
├── fixtures/
│   ├── mock-abestar.html       # replica of col-right DOM + typing animation + dots
│   └── logs/
│       ├── raw-session-1.json  # PROVIDED with this plan: raw DOM mutation log of a real session (see §2.5)
│       └── settled-events.json # create from Appendix B: settled per-card events from later sessions
└── .github/workflows/
    ├── pages.yml               # build viewer → GitHub Pages
    └── ci.yml                  # typecheck, lint, unit + e2e tests
```

Tooling: Node 20+, npm workspaces, TypeScript strict, Vitest (unit), Playwright (e2e, Chromium with the
unpacked extension loaded), ESLint + Prettier, Supabase CLI for local backend (`supabase start`, needs a Docker runtime: Colima locally, started
on demand; GitHub's Docker in CI).

---

## 4. Sub-project A — Chrome extension (MV3)

### 4.1 Components
| Part | Responsibility |
|---|---|
| **content script** | Finds `col-right`, observes it, turns DOM changes into `SegmentEvent`s, sends them to the background worker. No network, no credentials. |
| **background service worker** | Holds the broadcast token, current broadcast session (id, PIN, epoch), outbound queue; calls the Supabase RPCs; retries. |
| **popup** | Start/stop a broadcast, show PIN + viewer link (with `?pin=`) + QR code, live status (connected, segments sent, last error). |
| **options page** | Broadcast token (pasted once). Overrides for the baked-in Supabase URL / publishable key / viewer base URL, allowed Abestar host patterns, debounce ms. |

### 4.2 Manifest essentials
- `manifest_version: 3`
- `permissions`: `storage`, `activeTab`, `scripting`
- `host_permissions`: `https://*.abestar.com.tw/*` and the Supabase project URL (`https://<ref>.supabase.co/*`, baked in at build)
- `content_scripts.matches`: `https://*.abestar.com.tw/presentation/*` (configurable list in options; inject via `chrome.scripting` for extra hosts)

### 4.3 Capture algorithm (content script)
1. Wait for `[data-testid="col-right"]` (observe `document.body` until it appears; React may unmount/remount it — re-attach if it disappears).
2. `MutationObserver` on `col-right` with `{subtree, childList, characterData, attributes}`.
3. For each mutation, resolve the owning card: `closest('[data-testid^="translation-"]')`, excluding `translation-dots-*` elements themselves (the card is the `div` whose testid matches `/^translation-\d+$/`).
4. **Per-card debounce** (default 400 ms): after the card stops mutating, read it:
   - If it contains `[data-testid^="translation-dots"]` → placeholder, skip.
   - `text` = `textContent` of the `<p>` without a `data-testid`, trimmed. Skip if empty.
   - `seq` = N parsed from the testid; `lang` = card `lang` attribute.
5. Compare with `lastSent[seq]`:
   - unseen → emit `{type:'upsert', seq, text, lang}` (new)
   - seen and `text` differs → emit the same upsert (server bumps version — see §6.4)
   - identical → nothing
6. **Epoch / reset detection:** if the column loses all cards (broom/clear) or a card with N ≤ max seen appears while the
   previous cards are gone, clear `lastSent` and send `{kind:'reset'}`. A freshly loaded content script (page reload)
   also sends `reset` on its first attach. The **background worker owns the epoch**: it increments the session's epoch
   (persisted in `chrome.storage.session`) on every `reset` and stamps it on outgoing segments, so a reload never
   overwrites earlier lines. Epochs need not be contiguous. Segment key is `(session, epoch, seq)`.
7. **Start mid-talk:** when broadcast starts, existing cards are ignored by default (snapshot their text into
   `lastSent`); popup checkbox "include existing text" sends them as a backfill instead.
8. Health: if `col-right` isn't found within 10 s, report `status: 'column-not-found'` → popup shows warning and the
   action badge turns red. All selectors come from `selectors.ts` so a DOM change is a one-file fix.

### 4.4 Background worker
- Supabase JS client (`@supabase/supabase-js`) with the publishable key and no auth session (`persistSession: false`).
- Auth: the **broadcast token** from `chrome.storage.local`, passed as an argument to the RPCs in §6.2
  (`start_session`, `upsert_segment`, `end_session`). No Supabase Auth user for the broadcaster.
- `start_session` returns `{id, pin}`; if another session is live the popup first asks
  "A broadcast is already live. End it and start a new one?" and then calls with `force := true`.
- Outbound queue persisted in `chrome.storage.session` so a sleeping/restarted worker doesn't lose segments.
  Writes are **idempotent upserts** on `(session_id, epoch, seq)` → safe to retry. Exponential backoff, max 30 s.
  A 401/403-type RPC error (bad token, session ended) stops retrying and surfaces in the popup.
- Only one tab may broadcast at a time; a second tab gets "another tab is broadcasting".
- Keep-alive is not needed: content-script messages wake the worker.

### 4.5 Popup UX
- No token set → "Paste your broadcast token in Options" with a link.
- Idle → title field (default "Talk YYYY-MM-DD"), "include existing text" checkbox, **Start broadcast**.
- Broadcasting → big status (● Live / ● Reconnecting / ● Column not found), **PIN in large digits**, segments sent count,
  viewer URL `…/?pin=NNNNNN` with **Copy** button and **QR code** (`qrcode` npm package, rendered to canvas; "Open
  fullscreen QR" for projecting, showing the PIN under the QR for people who type it), **End broadcast**.

### 4.6 Extension tests
- Unit (Vitest + jsdom): capture logic driven by `fixtures/logs/*` replays and synthetic DOM: placeholder skipped,
  typing animation yields exactly one event, text change yields a second event, reset on clear and on fresh load, remount re-attach.
- E2E (Playwright, Chromium with `--load-extension`): open `fixtures/mock-abestar.html` (served from a local
  host that matches the content-script pattern, or injected via the options host list) against local Supabase;
  assert rows appear in `segments`; reload the mock mid-broadcast and assert new rows land in a new epoch.

### 4.7 Packaging
- `npm run package -w extension` builds with the production Supabase URL / publishable key / viewer URL and writes
  `extension/dist/abestar-broadcast-<version>.zip`. Not published to the Chrome Web Store; handed out as a zip and loaded unpacked.

---

## 5. Sub-project B — Audience viewer (GitHub Pages)

Static site: vanilla TypeScript built with Vite, deployed by GitHub Actions. No server code.

### 5.1 Session selection by PIN (works on a static page)
- URL: `https://samsonchen.github.io/abestar-broadcast/?pin=NNNNNN` — produced by the extension (link + QR).
  The query string is read client-side, so static hosting is fine.
- No `?pin=` → PIN dialog (numeric keypad on phones: `inputmode="numeric"`). After a successful join the PIN is
  written into the URL with `history.replaceState` so a reload rejoins.
- Wrong PIN, or the session has ended → "PIN not valid or broadcast has ended" (deliberately the same message).
  Too many attempts → "Too many attempts, try again in a few minutes".
- Session ends while watching → "Broadcast ended" banner; lines on screen stay until reload; no further fetches.

### 5.2 Data flow
1. Load `config.js` (Supabase URL + publishable key).
2. `supabase.auth.signInAnonymously()` (reuse the stored anonymous session if present).
3. `rpc('join_session', {pin})` → session row (id, title, target_lang, status). Fails if PIN wrong / not live / rate-limited.
4. `select * from segments where session_id = … order by epoch, seq` (RLS allows it only for joined viewers of a live session).
5. Subscribe to Realtime changes for that session (INSERT + UPDATE on `segments`, UPDATE on `sessions` for status).
6. **Gap safety:** on (re)subscribe and on `visibilitychange` → visible (phones sleep!), re-fetch rows with
   `updated_at >= lastSeenUpdatedAt` and merge. Merge is keyed by `(epoch, seq)` and ignores equal or lower `version`s.
7. **Idle notice:** no new segment for 10 min while live → subtle "No new lines for 10 min" note.

### 5.3 Rendering
- One card per segment, newest at the bottom (same mental model as Abestar). Optional "newest on top" toggle.
- **Auto-scroll** while the user is at the bottom; if they scroll up, stop and show a "↓ New lines" pill.
- **Revisions (version > 1):** word-level diff of `prev_text` → `text` (`diff` npm package, `diffWords`).
  Changed/inserted words are rendered in a distinct **revision color** (e.g. amber background) and stay colored;
  removed words are not shown (optional setting: show struck-through). Small "revised" tag on the card.
  Brief flash animation when a revision lands.
- New segments: fade-in (no fake typing animation; respect `prefers-reduced-motion`).

### 5.4 Mobile-first requirements
- Readable from a seat: default 20 px text, **A− / A+** buttons (persist in `localStorage` with try/catch).
- Light/dark following system, with a manual toggle.
- **Screen Wake Lock API** (`navigator.wakeLock.request('screen')`) while live, re-acquired on visibility change; graceful no-op where unsupported (older iOS).
- Connection indicator (Live / Reconnecting / Offline) in a small header; header shows session title.
- Works in iOS Safari, Android Chrome, desktop Chrome/Safari/Firefox/Edge. 16 px side gutters, no horizontal scroll, safe-area insets.
- English-only UI strings.
- No visible login (the anonymous Supabase session lives in `localStorage`), no cookies, no tracking.

### 5.5 Deployment
- `viewer/vite.config.ts` → `base: '/abestar-broadcast/'` (repo `samsonchen/abestar-broadcast`, now public).
- `.github/workflows/pages.yml`: on push to `main` touching `viewer/**` → build → `actions/deploy-pages`.
- `public/config.js` committed with the production Supabase URL + publishable key (public by design; security is RLS + PIN).

### 5.6 Viewer tests
- Unit: merge logic (ordering, out-of-order delivery, duplicate events, lower version ignored), diff rendering.
- E2E (Playwright, mobile viewport + desktop): against local Supabase, insert/update rows and assert the UI; reload
  mid-session shows history; simulate offline → online catch-up; PIN via URL, via dialog, wrong PIN, ended session,
  and an old PIN after a new broadcast started.

---

## 6. Sub-project C — Supabase backend

Everything lives in `supabase/migrations/` and is applied with the Supabase CLI. Developed against local Supabase
(`supabase start`), then pushed to the hosted project (`supabase db push`).

### 6.1 Schema (sketch — finalize in `0001_init.sql`)
```sql
create table public.sessions (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  target_lang      text,
  status           text not null default 'live' check (status in ('live','ended')),
  created_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at         timestamptz
);
-- at most one live session
create unique index one_live_session on public.sessions ((true)) where status = 'live';

-- not exposed through the API (schema `private` is not in the API's exposed schemas)
create table private.session_pins (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  pin        text not null check (pin ~ '^[0-9]{6}$')
);
create table private.broadcast_token (
  id         boolean primary key default true check (id),   -- single row
  token_hash text not null                                   -- sha256 hex of the token
);
create table private.join_attempts (
  user_id uuid not null, at timestamptz not null default now(), ok boolean not null
);
create table public.session_viewers (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (session_id, user_id)
);

create table public.segments (
  session_id  uuid not null references public.sessions(id) on delete cascade,
  epoch       int  not null default 0,
  seq         int  not null,
  text        text not null,
  prev_text   text,                       -- previous text when revised
  version     int  not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (session_id, epoch, seq)
);
create index on public.segments (session_id, updated_at);
```

### 6.2 Access control: RPCs + Row Level Security
RLS is enabled on every public table. **No client may INSERT/UPDATE/DELETE tables directly**; all writes go through
`security definer` functions (with `set search_path = ''`):

| Function | Caller | Does |
|---|---|---|
| `start_session(token, title, target_lang, force bool)` | extension | Checks `sha256(token)`. If a session is live and not `force` → error `session_live`; with `force` → ends it. Creates the session and a fresh random 6-digit PIN (different from the previous session's). Returns `{id, pin}`. |
| `upsert_segment(token, session_id, epoch, seq, text)` | extension | Checks token and that the session is live; upserts the segment; bumps `last_activity_at`. |
| `end_session(token, session_id)` | extension | Sets `status='ended'`, `ended_at=now()`. |
| `join_session(pin)` | viewer (anonymous user) | Rate limit: ≤ 5 failed attempts per user per 10 min (via `private.join_attempts`). If the PIN matches the live session → insert `(session_id, auth.uid())` into `session_viewers` and return the session row; otherwise a generic error. |

Read policies (role `authenticated`, which includes anonymous users):
- `sessions` SELECT: the user has a `session_viewers` row for it (any status, so the "ended" UPDATE still reaches the viewer).
- `segments` SELECT: the user joined the session **and** it is `live`. Ended → no reads ("when it ends, it ends").
- `session_viewers` SELECT: own rows only.
- `anon` (not signed in) can read nothing.

Auth settings (in `supabase/config.toml`, applied with `supabase config push`): anonymous sign-ins **on**;
email/phone sign-ups **off** (no real users are needed). Verify the exact keys and whether disabling sign-ups also blocks
anonymous sign-ins against the current Supabase docs in M1. Keep Supabase's per-IP anonymous sign-in rate limit.

Broadcast token: generated by the setup script (`openssl rand -base64 32`), shown to the owner once, only its sha256
stored. Replacing it = re-run the script's token step (documented in the guide; no rotation feature).

### 6.3 Realtime
- **v1 (default): Postgres Changes.** `alter publication supabase_realtime add table public.segments, public.sessions;`
  Viewer subscribes with filter `session_id=eq.<id>`. Realtime applies the read policies above per subscriber, which
  is fine for ≤ 40 viewers.
- **Scale option: Broadcast from Database.** Postgres Changes checks RLS per subscriber per change; for large audiences,
  Supabase recommends Broadcast. Add a trigger that publishes each segment change to topic `session:<id>` and switch the
  viewer to a Broadcast subscription. **Verify the current Supabase docs/API before implementing** (function names and the
  public-vs-private channel setup have changed over time). Keep the viewer's subscription behind one small interface so this swap is local.
- Check the project's plan limits (concurrent Realtime connections, messages/sec) against the expected audience size before a big event.

### 6.4 Revision handling (server-authoritative)
`BEFORE UPDATE` trigger on `segments`: if `new.text is distinct from old.text` then
`new.prev_text := old.text; new.version := old.version + 1; new.updated_at := now()`; otherwise `return null` so the
row is not written at all (a retried upsert then produces no Realtime event). The extension always just upserts
`(session_id, epoch, seq, text)` via `upsert_segment`; it never computes versions.

### 6.5 Housekeeping
- **Auto-end (on):** pg_cron job every 10 min ends sessions with `status='live'` and `last_activity_at < now() - 2 hours`.
- Optional scheduled cleanup (pg_cron) deleting sessions older than N days — off by default.
- `seed.sql` creates a demo live session (known PIN `123456`) with a few segments for local dev and viewer e2e tests,
  and a known local-only broadcast token.

### 6.6 Supabase setup: script first, short guide second
The owner prefers the CLI over clicking. Everything the Supabase CLI can do goes into `scripts/supabase-setup.sh`;
`docs/supabase-setup.md` covers only what a human must do, plus verification and troubleshooting.

**`scripts/supabase-setup.sh`** (idempotent, safe to re-run; bash, macOS):
1. Check prerequisites (`supabase`, `openssl`, `jq`) and that `supabase login` has been done.
2. Create the project if needed: `supabase projects create abestar-broadcast --org-id <org> --region us-west-2
   --db-password <generated>` (lists orgs and asks which one if there are several). Print the generated database
   password once and tell the owner to store it in a password manager. Or link an existing project (`--project-ref`).
3. `supabase link`, `supabase db push` (schema, RLS, functions, Realtime publication, pg_cron job), `supabase config push`
   (auth settings from `config.toml`).
4. Generate the broadcast token, store its sha256 in `private.broadcast_token`, print the token once.
   Skip this step if a token already exists, unless `--new-token` is given (the manual leak-recovery path).
5. Fetch the project URL and publishable key (`supabase projects api-keys`) and write them into
   `viewer/public/config.js` and the extension's build defaults.
6. Run the verification checks from guide §5 and print PASS/FAIL.
Never prints or stores the secret/service_role key.

**`docs/supabase-setup.md`** requirements:
- **Accurate to this repo.** Commands, file names and settings match the code. Write it after M1, re-check at M5.
- **Checked against current Supabase docs** (web search, not memory). Dated, "Supabase UI/CLI as of <date>", official
  doc link per step.
- **No secrets** in the guide or the repo except the publishable key. Says which values are public (project URL,
  publishable key) and which must never be shared (secret/service_role key, database password, broadcast token).

Sections (in this order):
1. **Overview.** Diagram: the extension writes through RPCs, Realtime pushes, viewers read after entering a PIN. What
   the owner ends up with: a project URL, a publishable key, a broadcast token.
2. **What you do by hand.** Create a Supabase account (and organization), stay on the free plan, install the CLI
   (`brew install supabase/tap/supabase`), run `supabase login`. Current free-plan limits that matter (Realtime
   connections/messages, pausing after inactivity).
3. **Run the setup script.** What it asks, what it prints, where to store the database password and the token.
4. **Install the extension.** Load the zip unpacked, paste the token in Options.
5. **Verify end to end.** The script's checks, plus manual ones: start a broadcast on the mock page, open the viewer
   on a phone with the QR, see lines appear; end it and confirm the viewer shows "Broadcast ended".
6. **Before an event.** Checklist: project not paused (`supabase projects list`; restore it the day before if paused),
   token pasted in the extension, a quick test broadcast.
7. **Maintenance.** Future migrations (`supabase db push`), replacing a leaked token (`--new-token`), deleting old
   sessions, exporting a transcript.
8. **Troubleshooting.** Symptoms → causes → fixes: viewer stuck on "Reconnecting", "PIN not valid", extension shows
   "invalid token", rows written but viewer doesn't update (Realtime publication or RLS), project paused.

Also link the guide from the root `README.md` as the first thing to do after cloning.

---

## 7. Shared contract

`shared/src/types.ts`:
```ts
export type SessionStatus = 'live' | 'ended';
export interface Session { id: string; title: string; target_lang: string | null;
  status: SessionStatus; created_at: string; last_activity_at: string; ended_at: string | null; }
export interface Segment { session_id: string; epoch: number; seq: number; text: string;
  prev_text: string | null; version: number; created_at: string; updated_at: string; }
// content script → background (the background worker stamps the epoch)
export type CaptureMessage =
  | { kind: 'segment'; seq: number; text: string; lang: string | null }
  | { kind: 'reset'; reason: 'load' | 'clear' }
  | { kind: 'status'; status: 'ok' | 'column-not-found' | 'detached' };
```

---

## 8. Milestones (each ends green in CI)

| # | Milestone | Done when |
|---|---|---|
| M0 | Monorepo scaffold, CLAUDE.md, CI (typecheck/lint/test), `fixtures/logs/raw-session-1.json` committed, `fixtures/mock-abestar.html` replicating §2.2 and the log in §2.5, including dots, the typing animation and the clear button | `npm test` passes; a mutation log recorded from the mock matches `raw-session-1.json` in sequence and approximate timing |
| M1 | Supabase migration (tables, RPCs, RLS, revision trigger, Realtime publication, auto-end cron), `config.toml` auth settings, seed; SQL tests (pgTAP or Vitest against local DB); `scripts/supabase-setup.sh` | not-signed-in can read nothing; wrong token cannot write; token holder can start/upsert/end; starting while live needs `force`; joined viewer reads a live session but not an ended one; wrong PIN rejected and rate-limited; changed text bumps version and sets prev_text, identical text writes nothing; first draft of `docs/supabase-setup.md` (§6.6) |
| M2 | Extension capture (content script) with unit tests from fixtures | each mock card produces exactly one event; changed text produces a second; reset on clear and on fresh load |
| M3 | Extension background + popup + options + zip packaging; e2e mock page → local Supabase | rows appear; reload mid-broadcast → new epoch, no overwrite; worker restart loses nothing; retries work offline→online; PIN + QR shown |
| M4 | Viewer: PIN dialog, join, subscribe, render, auto-scroll, revision coloring, font size, dark mode, wake lock; e2e on mobile + desktop viewports | live updates < 1 s locally; reload shows history; offline catch-up works; ended session stops; old PIN rejected |
| M5 | Pages deploy workflow; `docs/supabase-setup.md` finalized and re-checked against the code; end-to-end smoke test on the real Abestar test page | the owner can set up a fresh Supabase project using only `supabase login` + the script + the guide; presenter test with 2+ phones succeeds |
| M6 (opt) | Broadcast-from-Database switch, cleanup job, fullscreen QR, "newest on top" | load-tested with ~N simulated viewers |

**Human-only steps** (Claude Code should stop and list them, not attempt): creating the Supabase account/organization,
`supabase login`, running `scripts/supabase-setup.sh` against the hosted project and storing the printed database
password and broadcast token, enabling GitHub Pages in repo settings, loading the unpacked extension in Chrome and pasting
the token, the real-page smoke test with a microphone.

---

## 9. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Abestar changes its DOM (it's a `testgo.` test host) | All selectors in `selectors.ts`; column-not-found health check + red badge; fixtures updated from a fresh log |
| N restarts after clear/new presentation | `epoch` in the key (§4.3 step 6) |
| Old cards removed from DOM in long talks | Each card is sent once as soon as it settles; nothing depends on old cards |
| MV3 worker suspended mid-talk | Persisted queue + idempotent upserts |
| Phones sleep / lose network | Wake Lock + catch-up refetch on visibility/reconnect |
| Realtime limits for big audiences | ≤ 40 viewers expected; check plan limits if that grows; Broadcast-from-DB option (M6) |
| Presenter reloads Abestar mid-talk | Background-owned epoch; reload → new epoch, nothing overwritten |
| Previous audience reuses an old link | Fresh PIN per broadcast; ended sessions refuse joins and reads |
| PIN guessing | 6 digits, ≤ 5 failed attempts / user / 10 min, plus Supabase's per-IP anonymous sign-in limit |
| Broadcast token leaks | Only its hash is stored; `supabase-setup.sh --new-token` replaces it |
| Free project paused between events | "Before an event" checklist: check status and restore the day before |
| Forgotten "End broadcast" | Auto-end after 2 h idle; new broadcast force-ends the old one after confirmation |
| Terms of use for rebroadcasting Abestar output | Owner to confirm with Abestar before public use (not a code task) |

---

## Appendix A — DevTools logger used for verification
Reusable to re-check behavior after Abestar updates (paste in DevTools console on the Abestar tab, then `copy(JSON.stringify(__ev))`):
```js
const col = document.querySelector('[data-testid="col-right"]');
window.__seg = {}; window.__ev = []; const timers = {};
const CARD = '[data-testid^="translation-"]:not([data-testid^="translation-dots"])';
new MutationObserver(ms => {
  const cards = new Set();
  ms.forEach(m => {
    const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    const c = el?.closest(CARD); if (c) cards.add(c);
    m.addedNodes.forEach(n => n.nodeType === 1 && n.matches(CARD) && cards.add(n));
  });
  cards.forEach(card => {
    const id = card.dataset.testid;
    clearTimeout(timers[id]);
    timers[id] = setTimeout(() => {
      const p = card.querySelector('p');
      if (!p || p.dataset.testid) return;
      const text = p.textContent;
      const icon = card.querySelector('svg')?.getAttribute('class');
      const prev = __seg[id];
      if (!prev || prev.text !== text || prev.icon !== icon) {
        __ev.push({ t: performance.now() | 0, id, kind: prev ? 'CHANGED' : 'new', text, prevText: prev?.text, icon });
        if (prev) console.log('%cREVISION ' + id, 'color:orange;font-weight:bold', prev.text, '→', text);
        __seg[id] = { text, icon };
      }
    }, 300);
  });
}).observe(col, { subtree: true, childList: true, characterData: true, attributes: true });
```

## Appendix B — Sample settled events from the real page (for fixtures)
```json
[{"id":"translation-5","kind":"new","text":"The nine-in-one elections will be held on November 28th."},
 {"id":"translation-24","kind":"new","text":"Chiang Wan-an is only leading by 1.2 percentage points. He finds it unbelievable—how could he only be leading by 1.2 percentage points?"},
 {"id":"translation-25","kind":"new","text":"Chen Shih-chung is practically about to overtake him; the figures released today show a gap of over ten percentage points between the two."},
 {"id":"translation-31","kind":"new","text":"It is already evident that this is indeed"}]
```
Save the full set of these settled events as `fixtures/logs/settled-events.json`, and use them as realistic text in
`seed.sql` and the viewer tests. The raw first-session log is described in §2.5.
