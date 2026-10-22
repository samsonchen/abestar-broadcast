import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// `--mode localstack` points the viewer at the local Supabase stack (e2e tests and development).
export default defineConfig(({ mode }) => ({
  base: '/abestar-broadcast/',
  define: {
    __CONFIG__: readFileSync(
      new URL(
        `../shared/${mode === 'localstack' ? 'local' : 'public'}-config.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  },
}));
