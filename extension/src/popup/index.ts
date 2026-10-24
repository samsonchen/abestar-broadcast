// Popup: start/end a broadcast, show PIN, link and QR code, live status (PLAN.md §4.5).

import type { Voice } from '@abestar/shared';
import QRCode from 'qrcode';
import { DEFAULT_VOICE, effectiveConfig, viewerLink, type Settings } from '../config';
import { IDLE_STATE } from '../messages';
import type {
  BroadcastState,
  CreditsReply,
  StartError,
  StartReply,
  Status,
  ToBackground,
  TtsReply,
} from '../messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STATUS_TEXT: Record<Status, [string, 'live' | 'warn' | 'bad']> = {
  idle: ['', 'live'],
  live: ['● Live', 'live'],
  reconnecting: ['● Reconnecting…', 'warn'],
  'column-not-found': ['● Translation column not found on the page', 'bad'],
  'tab-closed': ['● The Abestar tab was closed; reopen it to continue', 'bad'],
  'ended-remotely': ['', 'bad'],
  'invalid-token': ['● Invalid token; paste it again in the options', 'bad'],
};

const START_ERRORS: Record<StartError, string> = {
  'no-token': 'Paste your broadcast token in the options first.',
  'invalid-token': 'The broadcast token was rejected. Paste it again in the options.',
  'session-live': '',
  busy: 'Another tab is already broadcasting.',
  'not-abestar':
    'Open the Abestar presentation page in this tab first (reload it if the extension was just installed).',
  network: 'Could not reach the server. Check the connection and try again.',
};

const send = <T>(message: ToBackground) => chrome.runtime.sendMessage(message) as Promise<T>;

async function targetTabId(): Promise<number | undefined> {
  // ?tab= lets tests (and a popup opened as a page) name the Abestar tab.
  const fromUrl = new URLSearchParams(location.search).get('tab');
  if (fromUrl) return Number(fromUrl);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

let creditsText = '';

function show(section: 'no-token' | 'idle' | 'live' | 'ended') {
  for (const id of ['no-token', 'idle', 'live', 'ended']) $(id).hidden = id !== section;
  $('credits').hidden = !creditsText || (section !== 'idle' && section !== 'live');
}

let renderedPin: string | null = null;

// Read-aloud is off for every new broadcast until ticked; it and the voice can be switched while live (e.g. for a
// second presenter). The voice is remembered across broadcasts.
const ttsBox = { idle: $<HTMLInputElement>('tts-idle'), live: $<HTMLInputElement>('tts-live') };
const voiceInputs = [...document.querySelectorAll<HTMLInputElement>('input[name^="voice-"]')];
const showVoice = (voice: Voice) => {
  for (const input of voiceInputs) input.checked = input.value === voice;
};
const chosenVoice = (form: 'idle' | 'live'): Voice =>
  (voiceInputs.find((i) => i.checked && i.name === `voice-${form}`)?.value as Voice) ??
  DEFAULT_VOICE;
/** The voice choice is shown only while read-aloud is ticked. */
const syncVoices = () => {
  for (const box of Object.values(ttsBox)) {
    const voices = box.closest('fieldset')?.querySelector<HTMLElement>('.voices');
    if (voices) voices.hidden = !box.checked;
  }
};

async function render(state: BroadcastState) {
  const settings = (await chrome.storage.local.get()) as Settings;
  if (state.status === 'ended-remotely') {
    $('ended-text').textContent =
      'This broadcast was ended elsewhere (a new broadcast was started, or it was idle for 2 hours).';
    return show('ended');
  }
  if (!state.broadcast) {
    renderedPin = null;
    showVoice(settings.voice ?? DEFAULT_VOICE);
    syncVoices();
    return show(settings.token ? 'idle' : 'no-token');
  }

  show('live');
  ttsBox.live.checked = state.broadcast.tts ?? false;
  showVoice(state.broadcast.voice ?? settings.voice ?? DEFAULT_VOICE);
  syncVoices();
  const [text, tone] = STATUS_TEXT[state.status];
  const status = $('status');
  status.textContent = text;
  status.className = `status ${tone}`;
  $('counts').textContent =
    `${state.sent} line${state.sent === 1 ? '' : 's'} sent` +
    (state.queued > 0 ? `, ${state.queued} waiting` : '');
  $('live-error').textContent = state.status === 'live' ? '' : (state.lastError ?? '');

  const { pin } = state.broadcast;
  if (pin !== renderedPin) {
    renderedPin = pin;
    const link = viewerLink(effectiveConfig(settings).viewerUrl, pin);
    $('pin').textContent = pin;
    const a = $<HTMLAnchorElement>('link');
    a.href = link;
    a.textContent = link;
    await QRCode.toCanvas($<HTMLCanvasElement>('qr'), link, { width: 200, margin: 1 });
  }
}

async function start(force: boolean) {
  const tabId = await targetTabId();
  const error = $('start-error');
  error.textContent = '';
  if (tabId === undefined) return;
  $<HTMLButtonElement>('start').disabled = true;
  try {
    const reply = await send<StartReply>({
      kind: 'start',
      tabId,
      title: titleInput.value.trim(),
      force,
      tts: ttsBox.idle.checked,
      voice: chosenVoice('idle'),
    });
    if (reply.ok) return;
    if (reply.error === 'session-live') {
      if (confirm('A broadcast is already live. End it and start a new one?')) await start(true);
      return;
    }
    error.textContent = START_ERRORS[reply.error];
  } finally {
    $<HTMLButtonElement>('start').disabled = false;
  }
}

// The last title typed is remembered; with none, a dated default.
const titleInput = $<HTMLInputElement>('title');
void chrome.storage.local.get('lastTitle').then(({ lastTitle }: Settings) => {
  titleInput.value = lastTitle?.trim() || `Talk ${new Date().toLocaleDateString('sv-SE')}`;
});
titleInput.addEventListener('input', () => {
  void chrome.storage.local.set({ lastTitle: titleInput.value.trim() } satisfies Settings);
});
/** Sends the live read-aloud switch and voice; on failure, shows the error and the unchanged state. */
async function sendLiveTts(): Promise<boolean> {
  const reply = await send<TtsReply>({
    kind: 'tts',
    on: ttsBox.live.checked,
    voice: chosenVoice('live'),
  });
  $('live-error').textContent = reply.ok ? '' : `Read-aloud not changed: ${reply.message}`;
  if (!reply.ok) await refresh();
  return reply.ok;
}
ttsBox.idle.addEventListener('change', syncVoices);
ttsBox.live.addEventListener('change', () => {
  syncVoices();
  void sendLiveTts();
});
for (const input of voiceInputs) {
  input.addEventListener('change', async () => {
    if (input.name === 'voice-live' && !(await sendLiveTts())) return;
    await chrome.storage.local.set({ voice: input.value as Voice } satisfies Settings);
  });
}
$('idle').addEventListener('submit', (e) => {
  e.preventDefault();
  void start(false);
});
$('end').addEventListener('click', () => {
  if (confirm('End the broadcast? Viewers will see "Broadcast ended".')) void send({ kind: 'end' });
});
$('copy').addEventListener('click', () => {
  void navigator.clipboard.writeText($<HTMLAnchorElement>('link').href);
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy link'), 1500);
});
$('fullscreen').addEventListener('click', () => {
  void chrome.tabs.create({ url: `qr.html?pin=${encodeURIComponent(renderedPin ?? '')}` });
});
$('open-options').addEventListener('click', () => void chrome.runtime.openOptionsPage());
$('ok').addEventListener('click', () => void send({ kind: 'dismiss' }));

async function refresh() {
  const { state } = (await chrome.storage.session.get('state')) as { state?: BroadcastState };
  await render(state ?? IDLE_STATE);
}
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session' || area === 'local') void refresh();
});
void refresh();

// The ElevenLabs balance, once per popup opening; hidden when read-aloud is not set up on the server.
void chrome.storage.local.get('token').then(async ({ token }: Settings) => {
  if (!token) return;
  const reply = await send<CreditsReply>({ kind: 'credits' });
  if (reply.ok) {
    const left = Math.max(0, reply.limit - reply.used).toLocaleString('en-US');
    const resets = reply.resetsAt
      ? `, resets ${new Date(reply.resetsAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';
    creditsText = `ElevenLabs: ${left} of ${reply.limit.toLocaleString('en-US')} credits left${resets}`;
  } else if (!reply.missing) {
    creditsText = `ElevenLabs credits unavailable (${reply.message})`;
  }
  $('credits').textContent = creditsText;
  await refresh();
});
