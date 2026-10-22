import { defineConfig, devices } from '@playwright/test';

// End-to-end tests. They need the local Supabase stack (`supabase start`) and run via `npm run test:e2e`.
// One worker: every test starts its own broadcast, which ends the previous one.
export default defineConfig({
  timeout: 90_000,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'extension', testDir: 'extension/e2e' },
    { name: 'viewer-desktop', testDir: 'viewer/e2e', use: { ...devices['Desktop Chrome'] } },
    { name: 'viewer-mobile', testDir: 'viewer/e2e', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'npx vite fixtures --port 5174 --strictPort',
      url: 'http://localhost:5174/mock-abestar.html',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev:local -w @abestar/viewer',
      url: 'http://localhost:5173/abestar-broadcast/',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
