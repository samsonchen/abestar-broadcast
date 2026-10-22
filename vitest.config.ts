import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'fixtures',
          include: ['fixtures/test/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
      // Needs the local Supabase stack, so it only runs via `npm run test:db`.
      ...(process.env.SUPABASE_IT
        ? [
            {
              test: {
                name: 'supabase',
                include: ['supabase/test/**/*.test.ts'],
                environment: 'node',
                testTimeout: 15_000,
                hookTimeout: 15_000,
              },
            },
          ]
        : []),
    ],
  },
});
