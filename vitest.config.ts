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
    ],
  },
});
