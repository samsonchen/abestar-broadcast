# Supabase setup

Written 2026-10-22 against Supabase CLI 2.121 (Supabase UI/CLI as of that date). First draft (M1);
re-checked at M5. Almost everything is done by `scripts/supabase-setup.sh`; this page covers what you do by hand,
how to check it worked, and what to do when it didn't.

## 1. Overview

```
Chrome extension ── RPC + broadcast token ──► Supabase (us-west-2)
                                               │  Postgres: sessions, segments
                                               │  Realtime: pushes new and revised lines
audience phones ◄── Realtime ───────────────────┘
  (anonymous sign-in, then join with the 6-digit PIN)
```

You end up with three values:

| Value                                     | Public? | Where it goes                                                       |
| ----------------------------------------- | ------- | ------------------------------------------------------------------- |
| Project URL (`https://<ref>.supabase.co`) | Yes     | `shared/public-config.json` (written by the script, committed)      |
| Publishable key (`sb_publishable_…`)      | Yes     | same file                                                           |
| Broadcast token                           | **No**  | your password manager, and pasted once into the extension's options |

Never share or commit the **database password** or the **secret / service_role key** (`sb_secret_…`). This project
does not use the secret key at all.

## 2. What you do by hand

1. **Supabase account.** Already done (organization `samson-org`). Stay on the **Free** plan. The limits that matter
   here ([pricing](https://supabase.com/pricing), [Realtime limits](https://supabase.com/docs/guides/realtime/limits)):
   - 200 concurrent Realtime connections (we expect ≤ 40 viewers), 100 messages/second, 2 million messages/month.
   - 2 active projects per organization.
   - **Projects pause after 1 week of inactivity.** See "Before an event" below.
   - Upgrade to Pro (from $25/month) only if audiences grow past ~150 or pausing becomes a nuisance.
2. **Install the CLI and jq** ([CLI docs](https://supabase.com/docs/guides/local-development/cli/getting-started)):
   ```sh
   brew install supabase/tap/supabase jq
   ```
3. **Log in** in a normal Terminal window (it opens the browser; it does not work from inside Claude Code):
   ```sh
   supabase login
   ```

## 3. Run the setup script

From the repository root:

```sh
scripts/supabase-setup.sh
```

What it does, in order:

1. Finds the project `abestar-broadcast`, or creates it in `us-west-2`. When it creates the project it prints a
   generated **database password once**: save it in your password manager before pressing Enter. On later runs it
   asks for that password (or reads `SUPABASE_DB_PASSWORD`).
2. Links the project and pushes the schema (`supabase db push`): tables, access rules, functions, Realtime,
   and the scheduled jobs.
3. Pushes the auth settings from `supabase/config.toml` (`supabase config push`). It shows each change and asks
   before applying it (`--yes` skips the questions). The settings:
   - anonymous sign-ins **on**, email and phone sign-ups **off**;
   - the global "allow new users to sign up" switch stays **on**, because turning it off also blocks anonymous
     sign-ins ([anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous));
   - anonymous sign-ins per IP raised from 30 to 300 per hour, since a whole audience on venue Wi-Fi shares one IP.
4. Creates the **broadcast token** and prints it **once**: save it in your password manager. Only its SHA-256 hash is
   sent to Supabase. Re-runs keep the existing token.
5. Writes the project URL and publishable key to `shared/public-config.json`.
6. Runs the checks below and prints PASS/FAIL.

Then commit `shared/public-config.json`.

## 4. Install the extension

The extension is not in the Chrome Web Store; it is loaded from a folder.

1. Build the zip (it uses `shared/public-config.json`, so run the setup script first):
   ```sh
   npm install
   npm run package -w @abestar/extension
   ```
   This writes `extension/dist/abestar-broadcast-<version>.zip`. Hand that file to other presenters.
2. Unzip it into a folder you will keep (Chrome loads it from there on every start).
3. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and pick
   the folder.
4. Pin the extension (puzzle icon in the toolbar → pin **Abestar Broadcast**).
5. Right-click the icon → **Options**, paste the broadcast token, **Save**.
6. Reload any Abestar tab that was already open, so the extension can read it.

To update: replace the folder's contents with the new zip, then click the reload icon on the extension's card in
`chrome://extensions`.

Custom icon (optional): put square PNGs named `icon-16.png`, `icon-32.png`, `icon-48.png` and `icon-128.png` in
`extension/static/icons/`, then build the zip again. The build adds whichever sizes exist to the manifest; without
any, Chrome shows a grey letter icon. Chrome's guidance: draw the 128 px icon at 96 × 96 inside 16 px of transparent
padding, keep the 16 and 32 px versions simple enough to read in the toolbar, and remember the status badge covers
the bottom-right corner.

To broadcast: open the Abestar presentation page, click the extension icon, **Start broadcast**, and show the QR code
(or **Fullscreen QR** on the projector). **End broadcast** when the talk is over.

## 5. Verify

The script checks, against the hosted project:

| Check                                               | Expected |
| --------------------------------------------------- | -------- |
| Reading `sessions` without signing in               | HTTP 401 |
| `start_session` with a wrong token                  | HTTP 401 |
| Anonymous sign-in                                   | HTTP 200 |
| Email sign-up                                       | HTTP 400 |
| Realtime publishes `segments` and `sessions`        | 2 tables |
| Scheduled jobs `auto-end-idle-sessions` and `prune` | 2 jobs   |

After M3/M4, also check by hand: start a broadcast on the mock page, scan the QR code with a phone, see lines appear,
end the broadcast, and see "Broadcast ended" on the phone.

## 6. Before an event

- [ ] The day before, check the project is not paused: `supabase projects list` shows `ACTIVE_HEALTHY`.
      If it is paused (`INACTIVE`), open the project in the [dashboard](https://supabase.com/dashboard) and restore it;
      this takes a few minutes.
- [ ] The broadcast token is pasted in the extension options on the presenting laptop.
- [ ] A 1-minute test broadcast reaches your own phone.

## 7. Maintenance

- **Schema changes:** add a file under `supabase/migrations/`, then `supabase db push --linked`.
- **Replace a leaked broadcast token:** `scripts/supabase-setup.sh --new-token`, then paste the new token into every
  extension install. The old token stops working immediately.
- **Old sessions:** kept until you delete them. To delete sessions older than 30 days:
  ```sh
  supabase db query --linked "delete from public.sessions where created_at < now() - interval '30 days'"
  ```
  Anonymous viewer accounts are deleted automatically after 7 days.
- **Export a transcript:**
  ```sh
  supabase db query --linked "select text from public.segments s join public.sessions x on x.id = s.session_id
    where x.title = 'Talk 2026-10-22' order by epoch, seq"
  ```

## 8. Troubleshooting

| Symptom                                               | Likely cause                                                                   | Fix                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Script: "Not logged in"                               | No CLI login on this Mac                                                       | `supabase login` in a normal Terminal                                                              |
| Script waits forever at "status" / project `INACTIVE` | Project paused                                                                 | Restore it in the dashboard, re-run                                                                |
| Extension says "invalid token" (HTTP 401)             | Token mistyped or replaced                                                     | Paste the token from your password manager again                                                   |
| Extension says "session live" (HTTP 409)              | Another broadcast is still live                                                | Confirm "end it and start a new one"                                                               |
| Viewer: "PIN not valid or broadcast has ended"        | Wrong PIN, or the talk ended                                                   | Use the PIN shown in the extension now                                                             |
| Viewer: "Too many attempts"                           | 5 wrong PINs in 10 minutes                                                     | Wait 10 minutes                                                                                    |
| Viewer stuck on "Reconnecting"                        | Network, or project paused                                                     | Check the phone's network; check the project status                                                |
| Lines are saved but the viewer doesn't update         | Realtime publication missing                                                   | Re-run the script; the "Realtime publishes" check must pass                                        |
| Many viewers can't sign in at a venue                 | Anonymous sign-in rate limit per IP                                            | Raise `anonymous_users` in `supabase/config.toml`, re-run the script                               |
| Script stops at "Pushing auth settings"               | `config.toml` declares a setting the plan does not allow (e.g. vector buckets) | `supabase config diff --project-ref <ref>`; set unused settings equal to the remote values, re-run |
