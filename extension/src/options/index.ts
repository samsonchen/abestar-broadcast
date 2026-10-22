// Options page: broadcast token, extra Abestar hosts, debounce, Supabase overrides.

import { buildConfig, DEFAULT_DEBOUNCE_MS, type Settings } from '../config';

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const extraHosts = document.getElementById('extra-hosts') as HTMLTextAreaElement;
const saved = document.getElementById('saved') as HTMLElement;

async function load() {
  const s = (await chrome.storage.local.get()) as Settings;
  input('token').value = s.token ?? '';
  extraHosts.value = (s.extraHosts ?? []).join('\n');
  input('debounce').value = String(s.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  input('supabase-url').value = s.supabaseUrl ?? '';
  input('supabase-url').placeholder = buildConfig.supabaseUrl;
  input('publishable-key').value = s.publishableKey ?? '';
  input('publishable-key').placeholder = buildConfig.publishableKey;
  input('viewer-url').value = s.viewerUrl ?? '';
  input('viewer-url').placeholder = buildConfig.viewerUrl;
}

document.getElementById('form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const hosts = extraHosts.value
    .split('\n')
    .map((h) => h.trim())
    .filter(Boolean);
  // Must run inside the click: Chrome only shows the permission prompt for a user gesture.
  if (hosts.length > 0 && !(await chrome.permissions.request({ origins: hosts }))) {
    saved.textContent = 'Not saved: Chrome permission for the extra pages was declined.';
    return;
  }
  const settings: Settings = {
    token: input('token').value.trim(),
    extraHosts: hosts,
    debounceMs: Number(input('debounce').value) || DEFAULT_DEBOUNCE_MS,
    supabaseUrl: input('supabase-url').value.trim(),
    publishableKey: input('publishable-key').value.trim(),
    viewerUrl: input('viewer-url').value.trim(),
  };
  await chrome.storage.local.set(settings);
  saved.textContent = 'Saved.';
});

void load();
