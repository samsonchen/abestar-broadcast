# abestar-broadcast

Rebroadcasts the translation column of Abestar GO! to phones: Chrome extension → Supabase → GitHub Pages viewer.
Read `PLAN.md` before starting a milestone; its §0 owner decisions override the rest of it.

## Commands

```sh
npm install
npm run typecheck   # root (fixtures) + every workspace
npm run lint
npm run format      # format:check in CI
npm test            # Vitest, all projects
npm run mock        # serves fixtures/mock-abestar.html on :5174 (add ?autoplay to replay session 1)
```

Local Supabase needs a Docker runtime (Colima; Finch does not work with the Supabase CLI):

```sh
colima start
cp supabase/functions/.env.example supabase/functions/.env   # once: Edge Function settings (ElevenLabs stub)
supabase start -x studio,imgproxy,mailpit,logflare,vector,supavisor,storage-api,postgres-meta
npm run test:db     # pgTAP (supabase/tests) + API/Realtime integration (supabase/test)
npm run test:e2e    # Playwright: extension (local build + mock page) and viewer (desktop + phone), local Supabase
supabase db reset   # re-apply migrations + seed.sql (token `local-dev-token`, demo PIN 123456)
# Edge Functions are loaded at start: after adding or renaming one, `supabase stop && supabase start …`
supabase stop && colima stop
```

Extension: `npm run build -w @abestar/extension` (prod, from `shared/public-config.json`), `build:local` (local stack +
mock on localhost:5174), `package` (prod zip in `extension/dist/`). Logic that touches `chrome.*` stays in thin
`index.ts` files; `capture.ts` and `broadcaster.ts` take their dependencies as arguments and are unit-tested.

Viewer: `npm run dev:local -w @abestar/viewer` serves it on http://localhost:5173/abestar-broadcast/ against the local
stack (Vite mode `localstack`, config from `shared/local-config.json`); `npm run build -w @abestar/viewer` builds for
GitHub Pages from `shared/public-config.json`. `transcript.ts`, `diff.ts` and `live.ts` are pure and unit-tested;
`supabase.ts` is the only file that talks to Supabase (the `Backend` interface).

Read-aloud (`docs/tts-plan.md`): the database decides what is spoken (`supabase/migrations/0002_tts.sql`), the Edge
Function `supabase/functions/tts` calls ElevenLabs (pure parts in `lib.ts`, tested in `supabase/unit`;
`tts-credits` reports the balance to the extension popup; shared settings in `_shared/env.ts`), and the
viewer plays clips (`audio-queue.ts` and `tts.ts` are pure and unit-tested; `player.ts` is Web Audio). Locally and in
CI, `supabase/functions/elevenlabs-stub` stands in for ElevenLabs, so tests spend no credits.

The hosted project is set up only by the owner via `scripts/supabase-setup.sh` (see `docs/supabase-setup.md`;
read-aloud with `--tts`, see `docs/elevenlabs-setup.md`).

## Conventions

- TypeScript strict everywhere, fixtures included (Vite and Vitest run them directly, no build step).
- TypeScript is pinned to `~6.0` because typescript-eslint does not support 7 yet.
- Workspaces: `shared` (types only, imported as `@abestar/shared`), `extension`, `viewer`.
- Every Abestar selector lives in `extension/src/content/selectors.ts`.
- `fixtures/logs/*.json` are recorded evidence: never edit or reformat them.
- `fixtures/mock-abestar.ts` must keep matching the recorded logs; `fixtures/test/mock-fidelity.test.ts` guards it.
  To record a new real-page log, see the header of `fixtures/raw-logger.ts`.
- Secrets: only the Supabase project URL and publishable key may be committed.
