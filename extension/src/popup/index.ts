// Popup: start/end a broadcast, show PIN, link and QR code, live status (PLAN.md §4.5).

import QRCode from 'qrcode';
import { effectiveConfig, viewerLink, type Settings } from '../config';
import { IDLE_STATE } from '../messages';
import type { BroadcastState, StartError, StartReply, Status, ToBackground } from '../messages';

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

function show(section: 'no-token' | 'idle' | 'live' | 'ended') {
  for (const id of ['no-token', 'idle', 'live', 'ended']) $(id).hidden = id !== section;
}

let renderedPin: string | null = null;

async function render(state: BroadcastState) {
  const settings = (await chrome.storage.local.get()) as Settings;
  if (state.status === 'ended-remotely') {
    $('ended-text').textContent =
      'This broadcast was ended elsewhere (a new broadcast was started, or it was idle for 2 hours).';
    return show('ended');
  }
  if (!state.broadcast) {
    renderedPin = null;
    return show(settings.token ? 'idle' : 'no-token');
  }

  show('live');
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
      title: $<HTMLInputElement>('title').value.trim(),
      includeExisting: $<HTMLInputElement>('include-existing').checked,
      force,
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

$<HTMLInputElement>('title').value = `Talk ${new Date().toLocaleDateString('sv-SE')}`;
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
