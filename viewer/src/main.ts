// Viewer entry: PIN from the URL or the dialog, join, then follow the broadcast (PLAN.md §5).
import type { Session } from '@abestar/shared';
import { setUpPreferences, wakeLock } from './device';
import { type JoinResult, LiveSession } from './live';
import { webAudioPlayer } from './player';
import { supabaseBackend } from './supabase';
import { Tts } from './tts';
import { byId, domView } from './ui';

const TTS_HINT = 'Read-aloud on. Keep this page open with the screen on; earphones recommended.';
const TTS_HINT_TAP = 'Tap anywhere on the page to resume read-aloud.';

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
const debug = debugLog();
const screen = wakeLock((status) => debug(`screen: ${status}`));

setUpPreferences();

/**
 * `?debug` in the URL shows the last few events at the bottom of the page (screen lock, visibility, connection,
 * read-aloud), for testing on phones without DevTools.
 */
function debugLog(): (line: string) => void {
  if (!new URLSearchParams(location.search).has('debug')) return () => {};
  const box = document.createElement('pre');
  box.className = 'debug';
  document.body.append(box);
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(`${new Date().toLocaleTimeString('en-GB')} ${line}`);
    box.textContent = lines.slice(-8).join('\n');
  };
  document.addEventListener('visibilitychange', () => log(`page ${document.visibilityState}`));
  log(navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''));
  return log;
}

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

  // Read-aloud (docs/tts-plan.md §8): off on every load; the button shows only when the server offers it.
  const ttsButton = byId<HTMLButtonElement>('tts');
  const ttsHint = byId('tts-hint');
  const offerTts = (row: Session) => {
    // Absent (not just null) while the hosted database predates read-aloud.
    const offered = row.status === 'live' && Boolean(row.tts_lang);
    ttsButton.hidden = !offered;
    if (!offered) tts.disable(row.status === 'live');
  };

  const view = domView(session.target_lang, {
    status: (status) => {
      debug(`status: ${status}`);
      screen.set(status !== 'ended');
      if (status === 'ended') offerTts({ ...session, status: 'ended' });
    },
    session: offerTts,
  });
  const tts = new Tts(
    backend,
    session.id,
    webAudioPlayer((state) => debug(`audio: ${state}`)),
    {
      active: (on) => {
        debug(`read-aloud ${on ? 'on' : 'off'}`);
        ttsButton.setAttribute('aria-pressed', String(on));
        ttsButton.setAttribute('aria-label', on ? 'Stop reading aloud' : 'Read aloud');
        ttsHint.hidden = !on;
      },
      speaking: (line) => view.speaking(line),
      needsTap: (on) => {
        debug(`read-aloud needs a tap: ${on}`);
        ttsHint.textContent = on ? TTS_HINT_TAP : TTS_HINT;
      },
    },
  );
  ttsButton.addEventListener('click', () => tts.toggle());
  // Capture phase, before the button's own click: a tap anywhere lets the phone play audio again.
  document.addEventListener('pointerdown', () => tts.tap(), { capture: true, passive: true });
  window.addEventListener('pagehide', () => tts.disable());
  offerTts(session);

  const live = new LiveSession(backend, session, view);
  window.addEventListener('online', () => live.setOnline(true));
  window.addEventListener('offline', () => live.setOnline(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void live.resync();
      tts.wake();
    }
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
