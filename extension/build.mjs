// Builds the unpacked extension into dist/<target>/ and, with --zip, a zip of it.
//
//   node build.mjs              production: Supabase project from shared/public-config.json
//   node build.mjs --local      local stack + the mock page on http://localhost:5174 (e2e tests)
//   node build.mjs --zip        production build plus dist/abestar-broadcast-<version>.zip

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const local = process.argv.includes('--local');
const zip = process.argv.includes('--zip');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

const config = local
  ? {
      supabaseUrl: 'http://127.0.0.1:54321',
      // The Supabase CLI's fixed local key; not a secret.
      publishableKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
      viewerUrl: 'http://localhost:5173/abestar-broadcast/',
    }
  : JSON.parse(readFileSync(join(here, '../shared/public-config.json'), 'utf8'));

const abestarPages = ['https://*.abestar.com.tw/presentation/*'];
const contentMatches = local ? [...abestarPages, 'http://localhost:5174/*'] : abestarPages;

const manifest = {
  manifest_version: 3,
  name: local ? 'Abestar Broadcast (local)' : 'Abestar Broadcast',
  version: pkg.version ?? '0.1.0',
  description: "Rebroadcasts Abestar GO!'s live translation to the audience's phones.",
  permissions: ['storage', 'activeTab', 'scripting', 'alarms'],
  host_permissions: [
    'https://*.abestar.com.tw/*',
    `${config.supabaseUrl}/*`,
    ...(local ? ['http://localhost:5174/*'] : []),
  ],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  background: { service_worker: 'background.js', type: 'module' },
  content_scripts: [{ matches: contentMatches, js: ['content.js'], run_at: 'document_idle' }],
  action: { default_popup: 'popup.html', default_title: 'Abestar Broadcast' },
  options_ui: { page: 'options.html', open_in_tab: true },
};

const out = join(here, 'dist', local ? 'local' : 'prod');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: {
    content: join(here, 'src/content/index.ts'),
    popup: join(here, 'src/popup/index.ts'),
    options: join(here, 'src/options/index.ts'),
    qr: join(here, 'src/qr/index.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  define: { __ABESTAR_CONFIG__: JSON.stringify(config) },
  logLevel: 'warning',
});
await esbuild.build({
  entryPoints: { background: join(here, 'src/background/index.ts') },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  define: { __ABESTAR_CONFIG__: JSON.stringify(config) },
  logLevel: 'warning',
});

cpSync(join(here, 'static'), out, { recursive: true });
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${out}`);

if (zip) {
  const file = join(here, 'dist', `abestar-broadcast-${manifest.version}.zip`);
  rmSync(file, { force: true });
  execFileSync('zip', ['-qr', file, '.'], { cwd: out });
  console.log(`Packed ${file}`);
}
