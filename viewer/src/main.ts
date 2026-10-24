// Viewer entry: PIN from the URL or the dialog, join, then follow the broadcast (PLAN.md §5).
import type { Session } from '@abestar/shared';
import { onTap, setUpPreferences, wakeLock } from './device';
import { type JoinResult, LiveSession } from './live';
import { webAudioPlayer } from './player';
import { supabaseBackend } from './supabase';
import { Tts } from './tts';
import { byId, domView } from './ui';

const TTS_HINT = 'Read-aloud on. Keep this page open with the screen on; earphones recommended.';
const TTS_HINT_TAP = 'Tap anywhere on the page to resume read-aloud.';
const ttsHintWaiting = (lang: string) =>
  `Read-aloud paused: it continues when the translation is in ${languageName(lang)}. ` +
  'Tap the speaker to choose another language.';

/** A language's name in itself, for the picker: English, 中文. */
function nativeName(lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

function languageName(lang: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

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
const awakeHint = byId('awake-hint');
const screen = wakeLock(
  (status) => debug(`screen: ${status}`),
  (on) => (awakeHint.hidden = !on),
);
// Wanted from the start, so that the tap that enters the PIN takes it; released when the broadcast ends.
screen.set(true);

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
    box.textContent = lines.slice(-14).join('\n');
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
  let tapNeeded = false;
  let waitingFor: string | null = null;
  const showHint = () => {
    ttsHint.textContent = tapNeeded
      ? TTS_HINT_TAP
      : waitingFor
        ? ttsHintWaiting(waitingFor)
        : TTS_HINT;
  };
  let latest = session;
  const offerTts = (row: Session) => {
    latest = row;
    const live = row.status === 'live';
    debug(`language ${row.target_lang ?? '?'}, read-aloud ${row.tts_lang ?? 'not offered'}`);
    // The broadcaster's switch; tts_on is absent while the hosted database predates read-aloud.
    const broadcasterOn = live && (row.tts_on ?? Boolean(row.tts_lang));
    if (!broadcasterOn) tts.disable(live);
    // Null while the translation is in a language without voices: a listener waits for theirs to return.
    tts.setLanguage(broadcasterOn ? row.tts_lang : null);
    // Shown while read-aloud is offered (the broadcaster has it on and there are voices), and while on.
    ttsButton.hidden = !(tts.enabled || ttsChoices().length > 0);
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
    {
      setTts: async (id, on, lang) => {
        const listening = await backend.setTts(id, on, lang);
        debug(`heartbeat ${on ? `on (${lang ?? 'any'})` : 'off'}: ${listening ? 'ok' : 'refused'}`);
        return listening;
      },
      listen: (id, onClip) =>
        backend.listen(
          id,
          (clip) => {
            debug(`clip ${clip.epoch}:${clip.seq} part ${clip.part + 1}/${clip.parts}`);
            onClip(clip);
          },
          (status) => debug(`audio channel: ${status}`),
        ),
    },
    session.id,
    webAudioPlayer(debug),
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
        tapNeeded = on;
        showHint();
      },
      waiting: (lang) => {
        debug(`read-aloud ${lang ? `waits for ${lang}` : 'in the current language'}`);
        waitingFor = lang;
        showHint();
      },
    },
  );
  // The read-aloud languages with voices; fetched once, before the start dialog needs them.
  let languages: string[] | null = null;
  const languagesLoaded = backend
    .ttsLanguages()
    .then((list) => void (languages = list))
    .catch(() => {});
  /** The languages to offer now, the translation's current one first; none while the broadcaster has it off. */
  const ttsChoices = (): string[] => {
    const on = latest.status === 'live' && (latest.tts_on ?? Boolean(latest.tts_lang));
    if (!on) return [];
    const current = latest.tts_lang;
    const all = languages ?? (current ? [current] : []); // null: a database from before the picker
    return current && all.includes(current) ? [current, ...all.filter((l) => l !== current)] : all;
  };

  const startDialog = byId<HTMLDialogElement>('start-dialog');
  const choice = (label: string, primary: boolean, action: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'primary' : 'secondary';
    button.textContent = label;
    // In the click itself: phones allow audio (and the wake lock) only during the tap.
    button.addEventListener('click', () => {
      startDialog.close();
      action();
    });
    return button;
  };
  /**
   * The start dialog. Its button is the tap a phone needs before it keeps the screen on or plays audio, and it picks
   * the read-aloud language (or none). `joining`: on joining, where without read-aloud it is a "Tap to continue" if
   * the screen still needs a tap; otherwise opened by the speaker button, which shows only while read-aloud is offered.
   */
  const openStart = (joining: boolean) => {
    const langs = ttsChoices();
    if (langs.length > 0) {
      byId('start-title').textContent = 'Read aloud?';
      byId('start-hint').textContent = 'Choose the language to hear; earphones recommended.';
      const chosen = tts.language;
      byId('start-choices').replaceChildren(
        ...langs.map((lang) =>
          choice(`${nativeName(lang)}${lang === chosen ? ' ✓' : ''}`, true, () =>
            tts.listenIn(lang),
          ),
        ),
        choice(`No read-aloud${!joining && !tts.enabled ? ' ✓' : ''}`, false, () => tts.disable()),
      );
    } else if (joining && screen.needsTap) {
      byId('start-title').textContent = title;
      byId('start-hint').textContent =
        'Tap to start following the live translation with the screen kept on.';
      byId('start-choices').replaceChildren(choice('Tap to continue', true, () => {}));
    } else return;
    debug(`start dialog: ${langs.join(', ') || 'continue'}`);
    if (!startDialog.open) startDialog.showModal();
  };
  // The speaker button opens the same picker: another language, or no read-aloud.
  ttsButton.addEventListener('click', () => openStart(false));
  // A tap anywhere lets the phone play audio again. Phones count a tap as a user gesture only when the finger
  // lifts (touchend; click elsewhere), not on pointerdown. Capture phase: before the button's own click.
  onTap(() => tts.tap());
  window.addEventListener('pagehide', () => tts.disable());
  offerTts(session);
  void languagesLoaded.then(() => {
    offerTts(latest);
    openStart(true);
  });

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
