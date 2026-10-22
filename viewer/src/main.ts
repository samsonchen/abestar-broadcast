// Viewer entry: PIN from the URL or the dialog, join, then follow the broadcast (PLAN.md §5).
import type { Session } from '@abestar/shared';
import { setUpPreferences, wakeLock } from './device';
import { type JoinResult, LiveSession } from './live';
import { supabaseBackend } from './supabase';
import { byId, domView } from './ui';

const JOIN_ERRORS: Record<Exclude<JoinResult, { ok: true }>['error'], string> = {
  'invalid-pin': 'PIN not valid or broadcast has ended.',
  'too-many-attempts': 'Too many attempts, try again in a few minutes.',
  network: 'Could not connect. Check your connection and try again.',
};

const backend = supabaseBackend(__CONFIG__);
const dialog = byId<HTMLDialogElement>('pin-dialog');
const form = byId<HTMLFormElement>('pin-form');
const input = byId<HTMLInputElement>('pin');
const error = byId('pin-error');
const joinButton = byId<HTMLButtonElement>('join');
const screen = wakeLock();

setUpPreferences();

function setPinInUrl(pin: string | null) {
  const url = new URL(location.href);
  if (pin) url.searchParams.set('pin', pin);
  else url.searchParams.delete('pin');
  history.replaceState(null, '', url);
}

function askPin(message = '') {
  error.textContent = message;
  if (!dialog.open) dialog.showModal();
  input.select();
}

async function join(pin: string) {
  const result = await backend.join(pin);
  if (!result.ok) {
    setPinInUrl(null);
    askPin(JOIN_ERRORS[result.error]);
    return;
  }
  setPinInUrl(pin);
  if (dialog.open) dialog.close();
  follow(result.session);
}

function follow(session: Session) {
  const title = session.title.trim() || 'Live translation';
  byId('title').textContent = title;
  document.title = `${title} · Live translation`;

  const live = new LiveSession(
    backend,
    session,
    domView(session.target_lang, (status) => screen.set(status !== 'ended')),
  );
  window.addEventListener('online', () => live.setOnline(true));
  window.addEventListener('offline', () => live.setOnline(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void live.resync();
  });
  if (!navigator.onLine) live.setOnline(false);
  void live.start();
}

dialog.addEventListener('cancel', (e) => e.preventDefault()); // nothing to show without a PIN
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = input.value.replace(/\D/g, '');
  if (pin.length !== 6) return askPin('Enter the 6 digits.');
  joinButton.disabled = true;
  await join(pin);
  joinButton.disabled = false;
});

const pin = new URLSearchParams(location.search).get('pin');
if (pin && /^\d{6}$/.test(pin)) void join(pin);
else askPin();
