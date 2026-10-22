import { defineConfig } from '@playwright/test';

// End-to-end tests. They need the local Supabase stack (`supabase start`) and run via `npm run test:e2e`.
export default defineConfig({
  testDir: 'extension/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'npx vite fixtures --port 5174 --strictPort',
    url: 'http://localhost:5174/mock-abestar.html',
    reuseExistingServer: !process.env.CI,
  },
});
