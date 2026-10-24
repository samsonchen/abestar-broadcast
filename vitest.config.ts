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
      {
        test: {
          name: 'extension',
          include: ['extension/test/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'viewer',
          include: ['viewer/test/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'functions',
          include: ['supabase/unit/**/*.test.ts'],
          environment: 'node',
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
                // Each file starts its own broadcast, which ends any other.
                fileParallelism: false,
                hookTimeout: 15_000,
              },
            },
          ]
        : []),
    ],
  },
});
