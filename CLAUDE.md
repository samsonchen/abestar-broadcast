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

Local Supabase (M1+) needs a Docker runtime: `colima start`, then `supabase start`; `colima stop` when done.
Finch does not work with the Supabase CLI.

## Conventions

- TypeScript strict everywhere, fixtures included (Vite and Vitest run them directly, no build step).
- TypeScript is pinned to `~6.0` because typescript-eslint does not support 7 yet.
- Workspaces: `shared` (types only, imported as `@abestar/shared`), `extension`, `viewer`.
- Every Abestar selector lives in `extension/src/content/selectors.ts`.
- `fixtures/logs/*.json` are recorded evidence: never edit or reformat them.
- `fixtures/mock-abestar.ts` must keep matching the recorded logs; `fixtures/test/mock-fidelity.test.ts` guards it.
  To record a new real-page log, see the header of `fixtures/raw-logger.ts`.
- Secrets: only the Supabase project URL and publishable key may be committed.
