# Text-to-speech (TTS) plan

Written 2026-10-23. Status: **implemented 2026-10-24** (T1–T4 and the T5 script; the hosted setup and smoke test are
the owner's steps). This replaces the "No audio" non-goal in `PLAN.md` §1; everything else in `PLAN.md` still
applies. The ElevenLabs account steps are in
[`elevenlabs-setup.md`](elevenlabs-setup.md).

## 0. Owner requirements (2026-10-23)

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | TTS is **off** by default on the viewer.                                                                                                                                                                                                                                                                                                                                                      |
| R2  | The viewer page has a toggle to turn TTS on and off.                                                                                                                                                                                                                                                                                                                                          |
| R3  | TTS is offered when the target language has voices: English, and Chinese (one voice pair for `zh-TW` and `zh-CN`, added 2026-10-24). More languages are rows in `private.tts_voices`.                                                                                                                                                                                                         |
| R4  | Speech runs **one line behind** the text, so a line is spoken only after the next line has appeared (it has had time to settle). A line that is revised after it was spoken is **not** spoken again.                                                                                                                                                                                          |
| R5  | When no viewer has TTS on, no ElevenLabs call is made.                                                                                                                                                                                                                                                                                                                                        |
| R8  | The translation may switch language mid-talk. A viewer listens in the language they turned read-aloud on in: it pauses (with a hint) while the translation is in another language and resumes when it returns; a line is synthesized only if some viewer listens in its language (`0003_tts_viewer_lang.sql`).                                                                                |
| R9  | On joining, a start dialog takes the tap a phone needs (screen kept on, audio allowed) and asks for the read-aloud language: one button per language with voices (`tts_languages()`, migration 0004) and "No read-aloud"; without read-aloud, "Tap to continue" only while the screen still needs a tap. The speaker button, shown only while read-aloud is offered, reopens the same picker. |

Added 2026-10-24, after the first implementation:

| #   | Requirement                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6  | The broadcaster decides whether read-aloud is offered at all: a checkbox in the extension, **off** by default (§7). Viewers see no toggle while it is off. |
| R7  | Nice to have: the extension shows how many ElevenLabs credits remain (§7).                                                                                 |

Owner answers (2026-10-24):

| #   | Decision                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Two voices, **calm female (US)** and **calm male (US)**. The broadcaster picks one in the extension so it matches the speaker's gender (§7). |
| D2  | Pause flush after **3 s** without a new line (§2.4).                                                                                         |
| D3  | **No per-session character cap.** The ElevenLabs key's credit quota is the only spending limit (`elevenlabs-setup.md` §2).                   |
| D4  | The viewer **marks the line being spoken** in v1 (§8).                                                                                       |

Decided in the discussion before this plan:

- TTS runs **on Supabase** (an Edge Function), not in the extension and not in the viewer. The ElevenLabs key stays a
  Supabase secret; the extension and viewer never see it.
- Model: ElevenLabs **Flash v2.5** (`eleven_flash_v2_5`), the cheapest and lowest-latency model.
- Audio is **not stored**. Each clip is pushed once over a private Realtime **Broadcast** channel and played by the
  phones listening at that moment. No replay, no Storage bucket, no catch-up audio for late joiners or reconnects.

## 1. Overview

```
Extension ── start_session(…, voice) / upsert_segment(text, lang) ──► Postgres
                                              │ trigger on INSERT of line N+1, or 3 s pause
                                              │   → decide whether line N is spoken (lag, language, listeners)
                                              │   → record a tts_jobs row, pg_net POST (after commit, async)
                                              ▼
                                         Edge Function `tts`
                                              │ ElevenLabs Flash v2.5 → MP3 (mp3_44100_64)
                                              │ Realtime Broadcast, private topic `tts:<session_id>`
                                              ▼
viewers with TTS on (subscribed to the topic) ── queue and play
viewers with TTS off: never subscribe, download nothing
```

Text delivery does not change and does not wait for TTS.

## 2. When a line is spoken (R4)

Lines are ordered by `(epoch, seq)` as in the viewer.

1. **One line behind.** When line N+1 is inserted, line N becomes eligible. N+1 can be in a later epoch (presenter
   reloaded Abestar); the last line of the old epoch is then spoken when the first line of the new epoch arrives.
2. **Latest text at speaking time.** The function reads line N's text when it runs, so revisions made while N was
   waiting are included.
3. **Spoken once.** A `tts_jobs` row is inserted for `(session_id, epoch, seq)` with a unique key before any call is
   made. A revision after that does not create another job (R4). A retried trigger cannot speak twice.
4. **Pause flush (D2).** If the speaker pauses, line N+1 may not arrive for a long time. A `pg_cron` job every
   second makes the newest line of a live session eligible once it has been on screen for `quiet_flush_seconds`
   (default **3**) without a successor, so it is spoken 3–4 s after it appeared. Set it to 0 to switch off the flush
   and keep the strict one-line lag. Each job records what released it (`next_line` or `pause`).

   Trade-off: if Abestar's lines often arrive more than 3 s apart, many lines will be released by the pause flush
   rather than by the next line, and a revision arriving after 3 s would not be heard. The recorded logs show no
   translation card changing after it settled, so this should be rare. After the first real talk, check the split
   with `select released_by, count(*) from private.tts_jobs group by 1` and raise the value if needed.

5. **Stale lines are dropped.** A line is not spoken if it is older than 2 minutes when it becomes eligible (e.g. after
   the extension was offline and uploads a backlog).
6. **Session end.** "When it ends, it ends" (`PLAN.md` §0): a line still waiting when the session ends is not spoken.
   Viewers unsubscribe on end, as they do for text.

## 3. Listener tracking (R5)

The server must know whether anyone is listening before it spends credits.

- New columns on `public.session_viewers`: `tts_until timestamptz` (null = TTS off).
- New RPC `set_tts(p_session_id uuid, p_on boolean)` for joined viewers of a live session. On: sets
  `tts_until = now() + 90 s`. Off: sets null.
- While TTS is on, the viewer calls `set_tts(…, true)` every 60 s as a heartbeat. A phone that sleeps, closes the tab
  or loses network stops counting after at most 90 s. On toggle off and on `pagehide` (best effort) it calls
  `set_tts(…, false)`.
- At enqueue time: `listeners = count(*) where tts_until > now()`. Zero → the job is recorded as `skipped` and no
  HTTP call is made. A skipped line is never spoken later, even if someone turns TTS on a second afterwards.

This costs at most 40 small RPCs per minute, far inside free-plan limits.

## 4. Languages (R3, and more later)

Today the content script captures each card's `lang` (`en-US`) but the background worker drops it, so
`sessions.target_lang` is always null. Changes:

- **Extension** sends `lang` with every line: `upsert_segment(…, p_lang text default null)`. Old extension builds
  (≤ 0.1.2) keep working and simply get no TTS.
- **`public.segments.lang`** stores it per line. **`sessions.target_lang`** is set by `upsert_segment` when it changes
  (first line, or if the presenter switches language mid-talk).
- **`private.tts_voices`**: one row per supported language and voice kind.

  | column          | example             | notes                                                       |
  | --------------- | ------------------- | ----------------------------------------------------------- |
  | `lang` (PK)     | `en`                | primary language subtag, lowercase; `en-US`, `en-GB` → `en` |
  | `voice` (PK)    | `female` / `male`   | the choice made in the extension (D1)                       |
  | `voice_id`      | `<voice id>`        | ElevenLabs voice ID (`elevenlabs-setup.md` §3)              |
  | `model_id`      | `eleven_flash_v2_5` |                                                             |
  | `language_code` | `en`                | passed to ElevenLabs                                        |
  | `enabled`       | `true`              | also the per-language kill switch                           |

  v1 ships with two rows, `(en, female)` and `(en, male)`. If the chosen kind has no enabled row for a language, the
  other kind is used. Adding Japanese later means inserting `ja` rows; no code change if the model supports it.

- **`sessions.tts_lang`** (new, nullable): set by the server to the matching `tts_voices.lang` whenever
  `target_lang` changes, null when there is no enabled voice. `sessions` is already in the Realtime publication, so
  viewers learn it from the existing UPDATE event. **The viewer shows the TTS toggle only when `tts_lang` is not
  null.** The viewer has no list of languages of its own.
- Eligibility is decided per line from `segments.lang`, so a mid-talk switch to an unsupported language stops speech
  immediately.

## 5. Database changes (`supabase/migrations/0002_tts.sql`)

- `segments.lang text`, `sessions.tts_on boolean not null default false` (R6), `sessions.tts_lang text` (null while
  `tts_on` is false, so viewers hide their toggle),
  `sessions.tts_voice text not null default 'female' check (tts_voice in ('female', 'male'))`,
  `session_viewers.tts_until timestamptz`.
- `private.tts_voices` (above); `private.tts_settings` (single row): `enabled` (global kill switch, default false
  until setup is done), `quiet_flush_seconds` (3), `function_url`.
- `private.tts_jobs`: `(session_id, epoch, seq)` PK, `status` (`queued` | `done` | `skipped` | `failed`),
  `skip_reason` (`no_listeners` | `language` | `stale` | `off` | `disabled`), `released_by` (`next_line` | `pause`), `voice`,
  `text_version`, `chars`, `created_at`, `finished_at`, `error`. Cascades with the session. It is the usage record
  for cost tracking.
- `private.tts_enqueue(session_id, epoch, seq)`: applies §2–§4, inserts the job (`on conflict do nothing`), and for a
  `queued` job calls `net.http_post` to the function with everything it needs (text, neighbouring lines, voice ID,
  model, language code). `pg_net` sends after the transaction commits, so `upsert_segment` stays as fast as it is
  now. A line without a language (extension before 0.2.0) uses the session's `target_lang`.
- The trigger catches every TTS error, so read-aloud can never break the text path.
- `AFTER INSERT` trigger on `segments` → `tts_enqueue` for the predecessor. Revisions (`UPDATE`) do nothing.
- `pg_cron` job `tts-flush`, every second (`'1 seconds'`) → pause flush (§2.4). It is one indexed query on the live
  session. Running every second writes ~86 000 rows a day to `cron.job_run_details`, so `private.prune()` also
  deletes run details older than a day.
- `upsert_segment` gains `p_lang`; drop and re-create it with the new signature and grant.
- `start_session` gains `p_voice text default 'female'` and `p_tts boolean default false`; same drop/re-create.
- New broadcaster RPC `set_session_tts(p_token, p_session_id, p_on, p_voice)` to turn read-aloud on or off and switch
  the voice during a live session (e.g. a second presenter). It applies from the next line released; lines released
  while off are recorded as `skipped / off`.
- `check_broadcast_token(p_token)`, granted to `anon`, for the Edge Function `tts-credits` (§7).
- `set_tts` RPC, granted to `authenticated`.
- RLS on `realtime.messages`: a joined viewer of a **live** session may `select` (receive) on topic
  `tts:<session_id>`; nobody may `insert` (send) from a client.
- `tts_deliver(p_secret, …, p_part, p_parts, p_audio, p_chars)` and `tts_fail(p_secret, …, p_error)`, called by
  the Edge Function with the publishable key and the shared secret. `tts_deliver` pushes the clip with
  `realtime.send(…, 'audio', 'tts:<session_id>', private => true)` and completes the job on the last part; it sends
  nothing for a job that is not queued or a session that has ended.
- Secrets in Supabase Vault: `tts_function_secret` (shared with the Edge Function, see §6). `function_url` is not
  secret.

## 6. Edge Function `supabase/functions/tts/index.ts`

- `verify_jwt = false`; the request must carry `x-tts-secret` equal to the `TTS_FUNCTION_SECRET` function secret,
  which `pg_net` reads from Vault. Anything else gets 401.
- Steps:
  1. Read the job from the request body: the line's text, the previous and next lines, and the voice chosen at
     release time (the database recorded the voice in the job).
  2. Split the text into chunks of at most 200 characters (60 in Chinese or Japanese) on sentence boundaries (about
     13 s of audio each), so every Realtime message stays well under the 256 KB limit.
  3. For each chunk: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_64` with
     `model_id`, `language_code`, and `previous_text` / `next_text` for smoother intonation. The one-line lag means
     `next_text` is already known. A voice with a `speed` (Chinese: 1.1, as its default reads slower than the Voice
     Library preview) sends `voice_settings`: the voice's stored settings (read once per voice) with that speed.
  4. Hand each clip to `tts_deliver` as soon as it is ready; the database sends it on `tts:<session_id>`. This needs
     only the publishable key, so neither the function nor anyone else uses the secret/service-role key.
  5. On any error call `tts_fail`. There is no retry: late audio is worthless.
- `ELEVENLABS_API_KEY`, `TTS_FUNCTION_SECRET`, `PUBLISHABLE_KEY` and `ELEVENLABS_BASE_URL` (default
  `https://api.elevenlabs.io`) come from function secrets. Locally they come from `supabase/functions/.env` (copied
  from `.env.example`), which points `ELEVENLABS_BASE_URL` at `supabase/functions/elevenlabs-stub`: it returns a short
  beep, 401 for a wrong key and 500 for text containing `TTS-FAIL`, so tests spend no credits.
- Pure parts (chunking, payload building) in `supabase/functions/tts/lib.ts`, unit-tested with Vitest. `index.ts`
  stays thin, like the extension's `index.ts` files.

Message payload (`shared/src/types.ts`):

```ts
export interface TtsClip {
  session_id: string;
  epoch: number;
  seq: number;
  part: number;
  parts: number; // chunk index within the line
  lang: string;
  text_version: number;
  format: 'mp3_44100_64';
  audio: string; // base64
}
```

## 7. Extension changes

- `api.ts` / `broadcaster.ts`: carry `lang` from the capture message to `upsert_segment`. The persisted queue item
  gets a `lang` field (old queued items without it send null).
- **Read-aloud checkbox (R6)** in the popup, under the title: "Offer read-aloud to viewers (English, Chinese)". Unticked for
  every new broadcast (not remembered), sent with `start_session`, and switchable while live (`set_session_tts`).
- **Voice selector (D1)**, shown while the checkbox is ticked: Female / Male. Remembered (`chrome.storage`), default
  Female. Sent with `start_session`; changing it while live calls `set_session_tts`. Shown even when the target
  language is not English, since the language is only known after the first line.
- **Credits line (R7)** under the form: "ElevenLabs: 8,766 of 10,000 credits left, resets Jan 15", fetched once each
  time the popup opens. The extension never holds the ElevenLabs key: it calls the Edge Function `tts-credits` with
  the broadcast token; the function checks the token (`check_broadcast_token`) and reads ElevenLabs
  `GET /v1/user/subscription` (`character_count`, `character_limit`, `next_character_count_reset_unix`), which needs
  the key's **User** permission. These are the account's credits, not the key's own quota, which the API does not
  report. Hidden when the function is not deployed; "unavailable" on other errors.
- Version 0.2.0.

## 8. Viewer changes

- **Toggle** in the header next to A− / A+ / theme: a speaker button (`aria-pressed`), hidden unless
  `session.tts_lang` is set. Off on every page load (R1); not remembered, because phones need a tap before they may
  play audio anyway.
- **Turning on** (inside the tap handler): create/resume an `AudioContext` (unlocks audio on iOS), subscribe to the
  private channel `tts:<session_id>`, call `set_tts(true)`, start the 60 s heartbeat. **Turning off**: stop playback,
  clear the queue, unsubscribe, `set_tts(false)`.
- **Playback queue** (`audio-queue.ts`, pure, unit-tested): keeps clips ordered by `(epoch, seq, part)`, plays one at
  a time, and when more than 2 lines are waiting drops the oldest whole lines so speech never drifts far behind the
  text. `player.ts` (thin) decodes with `decodeAudioData` and plays through the `AudioContext`.
- **Speaking marker (D4):** while a line's clips play, its card gets a `speaking` class: a small speaker icon and a
  subtle left border, in both themes. It moves to the next line when that line starts and is removed when the queue
  is empty or TTS is turned off. It does not change auto-scroll. The queue reports "now playing `(epoch, seq)`" so
  `ui.ts` only toggles a class.
- `supabase.ts` gets the channel and RPC; `live.ts` turns TTS off on session end. Reconnect: re-subscribe, no catch-up.
- Known phone limits, shown as a one-line hint under the toggle: keep the screen on (the wake lock already helps) and
  use earphones. Audio usually stops when the screen locks.

## 9. Configuration and secrets

| Value                      | Secret? | Where                                                                                     |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| ElevenLabs API key         | **Yes** | password manager; function secret `ELEVENLABS_API_KEY` (set by the setup script)          |
| TTS function secret        | **Yes** | generated by `scripts/supabase-setup.sh`; Vault + function secret; nobody needs to see it |
| Voice IDs, model, language | No      | `private.tts_voices` (setup script; `seed.sql` for local)                                 |
| Kill switch, pause flush   | No      | `private.tts_settings`                                                                    |

No part of the system uses the secret/service-role key: the function talks to the database through `tts_deliver` and
`tts_fail`, which check the shared secret.

## 10. Cost and limits

- Text: about 55 000 characters per hour of talk (estimate; English at ~150 words/min). Flash bills 0.5–1 credit per
  character over the API.
- Only lines with at least one listener are spoken (R5), and no audio is synthesised twice. A talk where nobody turns
  TTS on costs nothing.
- Plan sizing is in [`elevenlabs-setup.md`](elevenlabs-setup.md) §1.
- Supabase: Realtime Broadcast messages count against 2 M messages/month (one message per chunk per listener; ~40 ×
  ~600 per hour-long talk ≈ 24 000). Audio volume ≈ 30 MB per listener-hour at 64 kbps. Edge Function: one
  invocation per spoken line, far inside 500 000/month. All fit the free plan.
- No per-session cap (D3): a talk with listeners spends about 55 000 characters per hour, however long it runs. The
  key's credit quota stops spending when reached; text keeps working.
- Latency: line N is heard about 1.5–3 s after line N+1 appears (pg_net dispatch, function start, ElevenLabs Flash,
  Realtime), or about 4.5–7 s after N appeared when released by the pause flush.

## 11. Testing

- **pgTAP** (`supabase/tests`): N is enqueued when N+1 is inserted and not before; revision of N after its job →
  no new job; revision before → job reads the new text; zero listeners → `skipped/no_listeners`; expired heartbeat
  counts as zero; unsupported or null `lang` → `skipped/language`; kill switch; stale; pause flush after 3 s and not
  before (`released_by`); `set_tts` rejected for non-joined viewers and ended sessions; `realtime.messages` policy
  (joined viewer may receive, others may not, nobody may send); `tts_lang` follows `target_lang`; `start_session`
  voice default and check; read-aloud off by default, `set_session_tts` needs the token, clears `tts_lang` when off,
  skips lines as `off`, and changes the voice of later jobs only; fallback to the other voice kind.
- **Vitest**: chunker; audio queue (ordering, out-of-order arrival, drop policy, now-playing events); extension
  `lang` pass-through, read-aloud switch and voice (sent on start, `set_session_tts` on change); viewer toggle
  visibility from `tts_lang`; speaking marker follows now-playing.
- **Integration** (`supabase/test`, local stack with `edge-runtime` and the ElevenLabs stub): insert two lines with
  one listener → one clip arrives on the topic; no listener → no call to the stub.
- **Playwright**: toggle hidden while the broadcaster has read-aloud off and for a non-English session, shown for
  English, and follows the broadcaster switching it off and on; turning it on receives a clip (stub). Extension:
  checkbox off by default, voice choice appears with it, credits line from the stub, live switch.
- **Integration**: `tts-credits` returns the stub's balance for the broadcast token and 401 without it.
- **Manual, hosted**: one real talk segment on the Abestar test page with 2 phones, one with TTS on.

Local stack: `edge-runtime` is no longer in the `supabase start -x` list, and `supabase/functions/.env` must exist
before `supabase start` (`CLAUDE.md`; CI copies `.env.example`).

## 12. Milestones

| #   | Milestone                                                                                                          | Done when                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| T1  | Migration `0002_tts.sql`, shared types, pgTAP tests                                                                | all §11 pgTAP cases pass; `tts_jobs` shows the right status for each case                                     |
| T2  | Edge Function + ElevenLabs stub + Vitest + integration test                                                        | a clip reaches a subscribed client locally; no stub call without listeners                                    |
| T3  | Extension 0.2.0 sends `lang`; voice selector                                                                       | `segments.lang`, `sessions.target_lang` and `tts_voice` filled from the mock page; old queue items still send |
| T4  | Viewer toggle, channel, heartbeat, audio queue, speaking marker, e2e                                               | §8 behaviour on desktop and phone viewports                                                                   |
| T5  | `scripts/supabase-setup.sh` deploys the function and sets secrets and both voices; docs updated; hosted smoke test | owner can enable TTS with the setup guide only; 2-phone test passes with each voice                           |

Human-only steps: everything in `elevenlabs-setup.md` (account plan, API key, voice choice), running the setup script
against the hosted project, the hosted smoke test.

## 13. Risks

| Risk                                                                                                                     | Mitigation                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Credits run out mid-talk                                                                                                 | ElevenLabs key credit quota (no per-session cap, D3); "before an event" check of remaining credits; text keeps working when TTS fails |
| 3 s pause flush speaks a line before a late revision                                                                     | Cards were not seen changing after settling; `released_by` shows how often the flush fires; raise `quiet_flush_seconds` if needed     |
| `tts-flush` running every second fills `cron.job_run_details`                                                            | `private.prune()` deletes run details older than a day                                                                                |
| Speech drifts behind the text                                                                                            | One-line lag only; queue drops old lines when > 2 wait                                                                                |
| Phones stop audio when locked / iOS needs a tap                                                                          | Toggle is the tap; wake lock; hint text. A locked-screen stream (HLS) is out of scope                                                 |
| Heartbeat lost, credits spent for nobody                                                                                 | Listener expires after 90 s                                                                                                           |
| A line longer than one message allows                                                                                    | Chunking at 200 characters                                                                                                            |
| Clips pass through `realtime.messages` (`realtime.send`) and stay there until Realtime drops old partitions (a few days) | About 30 MB per hour of talk with listeners, stored once whatever the audience size; small against the free plan's 500 MB database    |
| ElevenLabs outage or slow response                                                                                       | Job marked `failed`; text unaffected; no retries                                                                                      |
| Text is sent to a third party (ElevenLabs keeps history on non-Enterprise plans)                                         | Mention to presenters; same text is already public to the audience                                                                    |
| Free plan is non-commercial and requires attribution                                                                     | Use Starter or higher for real events (`elevenlabs-setup.md` §1)                                                                      |
