# ElevenLabs setup

Written 2026-10-23 for the TTS plan ([`tts-plan.md`](tts-plan.md)). The ElevenLabs account already exists. Plan
prices and dashboard labels are as published on that date and were not checked by hand in the dashboard; confirm them
when you go through the steps. Steps 1–4 are done by you in the browser and Terminal; step 5 runs
`scripts/supabase-setup.sh --tts`.

## 1. Choose a plan

Only the Supabase Edge Function calls ElevenLabs, with the Flash v2.5 model. Flash bills **0.5–1 credit per
character** over the API (ElevenLabs gives a range; check the exact rate on your Usage page after the first test).
A one-hour talk produces about **55 000 characters** of English, and nothing is spoken while no viewer has TTS on.

| Plan    | Price/month | Credits/month | Speech per month (at 0.5–1 credit/char) | Commercial use               |
| ------- | ----------- | ------------- | --------------------------------------- | ---------------------------- |
| Free    | $0          | 10 000        | ~10–20 min                              | **No**; attribution required |
| Starter | $6          | 30 000        | ~30–60 min                              | Yes                          |
| Creator | $22         | 121 000       | ~2–4 h                                  | Yes                          |

Recommendation:

- **Development and local tests:** Free is enough. Automated tests use a stub and spend no credits; only the manual
  smoke test spends real credits.
- **Real events:** Starter for one short talk a month; **Creator** if you run more than one talk a month or talks
  longer than an hour. Free may not be used for public events (non-commercial, attribution required).
- Credits do not roll over on Free. Upgrade a few days before the event, not on the day.

Sources: [pricing](https://elevenlabs.io/pricing), [API pricing](https://elevenlabs.io/pricing/api).

## 2. Create a restricted API key

1. Sign in at [elevenlabs.io](https://elevenlabs.io), open **Developers → API Keys**, **Create API key**.
2. Name: `abestar-broadcast-supabase`.
3. Keep **Restrict key** on (the default). Give it access to **Text to Speech**, and **User: Read** (`user_read`; no access to
   anything else). **User** lets the extension popup show the remaining credits; without it, read-aloud still
   works and the popup says "ElevenLabs credits unavailable". If the test in step 4 returns `missing_permissions`, add
   the permission the error names (usually **Voices: Read**) and nothing else.
4. **Credit quota:** set a limit, for example the plan's monthly credits. The server has no per-session cap, so this
   is the **only** spending limit if something goes wrong (a stuck heartbeat, a runaway loop). Do not skip it.
5. Create it and **copy the key now**; it is shown once. Save it in your password manager as
   "ElevenLabs – abestar-broadcast".

Never commit the key, paste it into the extension, or put it in `shared/public-config.json`. It goes only into
Supabase function secrets (step 5).

Docs: [API keys](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys),
[authentication](https://elevenlabs.io/docs/api-reference/authentication).

## 3. Choose two voices

The broadcaster picks **Female** or **Male** in the extension to match the speaker, so you need one voice of each.

1. Open **Voices**. Pick a **calm female US English** voice that is clear at normal speed; a narration voice works
   better than a character voice for translation. **On the Free plan, only ElevenLabs' default voices work over the
   API** (in **Voices**, filter by **Default**); Voice Library voices return `402 paid_plan_required` until you
   upgrade to Starter or higher.
   **Default voices expire on 2026-12-31** and are offered only to accounts created before March 2026. Use them for
   testing on Free; before the first event (which needs Starter anyway), switch to their suggested replacements,
   e.g. Sarah → _Talia – Warm Soft Guide_, Brian → _Sawyer – Midnight Storyteller_ (full table:
   [What are Default voices?](https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices)).
   Switching is only new voice IDs: re-run `scripts/supabase-setup.sh --tts`; no code changes.
2. Open the voice's menu and **Copy voice ID**. Voice IDs are not secret.
3. Do the same for a **calm male US English** voice.
4. Note both IDs next to the key in your password manager, labelled female and male.

## 4. Test the key from Terminal

This spends about 100 credits. From the repository root, give it both voice IDs:

```sh
scripts/elevenlabs-test.sh <female-voice-id> <male-voice-id>
```

It asks for the API key (hidden; type or paste it at the prompt, then Enter), sends the same request the Edge
Function will send, plays the sentence for each voice, and shows the balance the extension popup will show (needs
the **User** permission). Expected: `OK (HTTP 200)` for each voice, you hear the sentence twice, and a balance line.
On an error it prints ElevenLabs' message; see §8.

The balance is the **account's** credits for the billing period, not what is left of the key's own credit quota (step 2.4);
ElevenLabs does not report that one through the API.

## 5. Connect it to Supabase

From the repository root, logged in as in `supabase-setup.md` (`supabase login`):

```sh
scripts/supabase-setup.sh --tts
```

It runs the normal setup first, which also pushes the read-aloud schema (`0002_tts.sql`), and asks for the database
password as usual. Then it asks for the ElevenLabs API key (hidden input) and the female and male voice IDs, and:

1. sets the function secrets `ELEVENLABS_API_KEY`, `TTS_FUNCTION_SECRET` (a new random value) and `PUBLISHABLE_KEY`
   (`supabase secrets set`, from a temporary file that is deleted at once);
2. deploys the Edge Functions `tts` and `tts-credits` (`supabase functions deploy … --no-verify-jwt --use-api`; no
   Docker needed);
3. stores the same `TTS_FUNCTION_SECRET` in Supabase Vault so the database can call the function;
4. writes the `(en, female)` and `(en, male)` rows of `private.tts_voices` (voice ID, `eleven_flash_v2_5`, `en`);
5. sets `private.tts_settings.enabled = true` and the function URL;
6. runs the checks in §6.

Re-running is safe. To change a voice later, re-run with `--tts` and enter the new voice ID; press Enter at any
prompt to keep the existing value.

Then:

- **Extension 0.2.0** (read-aloud checkbox, Female/Male selector, credits line, sends the language):
  `npm run package -w @abestar/extension` and replace
  the unpacked folder as in `supabase-setup.md` §4. Older extensions still broadcast text, without read-aloud (they
  don't send the language).
- **Viewer:** the GitHub Pages workflow deploys it on the next push to `main`.

## 6. Verify

The script checks:

| Check                                                             | Expected         |
| ----------------------------------------------------------------- | ---------------- |
| Function secrets list `ELEVENLABS_API_KEY`, `TTS_FUNCTION_SECRET` | both present     |
| Function `tts` called without the secret header                   | HTTP 401         |
| Function `tts-credits` called without the broadcast token         | HTTP 401         |
| `private.tts_voices` has enabled `en` rows                        | `female`, `male` |
| `private.tts_settings.enabled`                                    | true             |

Then by hand:

1. Open the extension popup. Under the Start button it shows "ElevenLabs: … credits left", matching the **Usage**
   page.
2. Start a broadcast on the Abestar test page with English as the target language and **read-aloud left unticked**.
   Join on a phone: there is no speaker button.
3. Tick **Offer read-aloud to viewers** in the popup. The speaker button appears on the phone within a few seconds.
   Join on a second phone. Both show the speaker button; it is **off**.
4. Turn it on on one phone. After two lines appear (or after a 3 s pause), the first line is spoken on that phone
   only, and that line is marked as speaking.
5. In the extension popup switch the voice to the other option. The next spoken line uses the other voice.
6. Turn it off on both phones and talk for a minute. On the ElevenLabs **Usage** page, credits do not go up; in
   Supabase:
   ```sh
   supabase db query --linked "select status, skip_reason, count(*) from private.tts_jobs group by 1, 2"
   ```
   shows the new lines as `skipped / no_listeners`.

## 7. Before an event and maintenance

Add to the "Before an event" checklist in `supabase-setup.md`:

- [ ] Plan is Starter or higher and enough credits remain (the popup's credits line or the ElevenLabs **Usage** page;
      budget ~55 000 characters per hour of talk with listeners).
- [ ] The voices are not ElevenLabs Default voices (they stop working after 2026-12-31; §3).
- [ ] Tick **Offer read-aloud to viewers** when starting the broadcast (it is off for every new broadcast).
- [ ] A 1-minute test broadcast speaks on your own phone.

Maintenance:

- **Usage per session:**
  ```sh
  supabase db query --linked "select s.title, sum(j.chars) from private.tts_jobs j
    join public.sessions s on s.id = j.session_id where j.status = 'done' group by 1 order by 1"
  ```
- **Switch TTS off for everyone** (text keeps working; viewers' toggle disappears on the next session):
  ```sh
  supabase db query --linked "update private.tts_settings set enabled = false"
  ```
- **Replace a leaked key:** delete it under **Developers → API Keys**, create a new one (step 2), run
  `scripts/supabase-setup.sh --tts`. The old key stops working at once.
- **Downgrade after the event:** you can return to Free between events; TTS will then stop when the 10 000 credits run
  out, and text is unaffected.

## 8. Troubleshooting

| Symptom                                                                     | Likely cause                                                                                                                                              | Fix                                                                                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Test in §4 returns `401`                                                    | Key mistyped, deleted, or `missing_permissions`                                                                                                           | Copy the key again; add the permission named in the error                                                                           |
| Test returns `402` or `quota_exceeded`                                      | Plan credits or the key's credit quota used up                                                                                                            | Check **Usage**; raise the key quota or upgrade                                                                                     |
| Test returns `402` `paid_plan_required`                                     | A Voice Library voice on the Free plan                                                                                                                    | Pick a default voice (§3), or upgrade to Starter                                                                                    |
| Test returns `404` / `voice_not_found`                                      | Wrong voice ID, or a library voice your plan cannot use                                                                                                   | Copy the ID again; choose a default voice                                                                                           |
| Test returns `429`                                                          | Too many requests at once (Free allows 2 concurrent)                                                                                                      | Wait and retry; upgrade if it happens during talks                                                                                  |
| No speaker button on the viewer                                             | Read-aloud not ticked in the popup, target language not English, `tts_settings.enabled` false, no enabled `tts_voices` row, or extension older than 0.2.0 | Tick it in the popup; check `select tts_on, target_lang, tts_lang from public.sessions where status = 'live'`; update the extension |
| Popup says "ElevenLabs credits unavailable"                                 | The key lacks the **User** permission, or the key/function is not set up                                                                                  | Add **User** to the key (step 2); re-run `scripts/supabase-setup.sh --tts`                                                          |
| Button on, but silence                                                      | Phone muted / silent switch; audio blocked until a tap; screen locked                                                                                     | Unmute, tap the button again, keep the screen on                                                                                    |
| Silence, and `tts_jobs` shows `failed`                                      | ElevenLabs error (key, credits, voice)                                                                                                                    | Read `error` in `private.tts_jobs`; fix per the rows above                                                                          |
| Silence, and `tts_jobs` shows `skipped / no_listeners` though a phone is on | Heartbeat not reaching Supabase                                                                                                                           | Check the phone's network; toggle off and on                                                                                        |
| Wrong voice gender                                                          | Voice selector in the extension popup, or the female/male IDs swapped in setup                                                                            | Switch it in the popup; or re-run `scripts/supabase-setup.sh --tts` with the IDs in the right order                                 |
| Speech lags far behind                                                      | Expected: one line behind (~2 s after the next line appears, or ~5 s after a pause); older lines are dropped if more than 2 wait                          | Nothing to fix unless lag keeps growing; report with the time and session title                                                     |
