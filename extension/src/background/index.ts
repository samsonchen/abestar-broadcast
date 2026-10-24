// Service worker: wires Broadcaster to chrome.* (PLAN.md §4.4).

import { DEFAULT_DEBOUNCE_MS, effectiveConfig, type Settings } from '../config';
import type { BroadcastState, Status, ToBackground, ToContent } from '../messages';
import { fetchCredits, supabaseApi } from './api';
import { Broadcaster, type QueueItem } from './broadcaster';

const settings = () => chrome.storage.local.get() as Promise<Settings>;

const BADGE: Record<Status, { text: string; color: string }> = {
  idle: { text: '', color: '#000000' },
  live: { text: 'ON', color: '#16a34a' },
  reconnecting: { text: '…', color: '#d97706' },
  'column-not-found': { text: '!', color: '#dc2626' },
  'ended-remotely': { text: '', color: '#000000' },
  'ended-tab-closed': { text: '', color: '#000000' },
  'ended-restart': { text: '', color: '#000000' },
  'invalid-token': { text: '!', color: '#dc2626' },
};

const broadcaster = new Broadcaster({
  // Created per call so a changed Supabase override on the options page applies without a restart.
  api: {
    startSession: async (...args) =>
      supabaseApi(effectiveConfig(await settings())).startSession(...args),
    upsertSegment: async (...args) =>
      supabaseApi(effectiveConfig(await settings())).upsertSegment(...args),
    setSessionTts: async (...args) =>
      supabaseApi(effectiveConfig(await settings())).setSessionTts(...args),
    endSession: async (...args) =>
      supabaseApi(effectiveConfig(await settings())).endSession(...args),
  },
  store: {
    load: () =>
      chrome.storage.session.get(['state', 'queue']) as Promise<{
        state?: BroadcastState;
        queue?: QueueItem[];
      }>,
    save: (state, queue) => chrome.storage.session.set({ state, queue }),
  },
  liveSession: {
    get: async () => (await settings()).liveSessionId,
    set: (id) =>
      id
        ? chrome.storage.local.set({ liveSessionId: id } satisfies Settings)
        : chrome.storage.local.remove('liveSessionId'),
  },
  getToken: async () => (await settings()).token,
  getDebounceMs: async () => (await settings()).debounceMs ?? DEFAULT_DEBOUNCE_MS,
  tell: async (tabId: number, message: ToContent) => {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      return false;
    }
  },
  showStatus: (status) => {
    const { text, color } = BADGE[status];
    void chrome.action.setBadgeText({ text });
    void chrome.action.setBadgeBackgroundColor({ color });
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
});

chrome.runtime.onMessage.addListener((message: ToBackground, sender, reply) => {
  const tabId = sender.tab?.id;
  const handle = async () => {
    switch (message.kind) {
      case 'hello':
        return tabId === undefined ? { capture: false } : broadcaster.hello(tabId);
      case 'capture':
        if (tabId !== undefined) await broadcaster.capture(tabId, message.message);
        return null;
      case 'start':
        return broadcaster.start(message);
      case 'tts':
        return broadcaster.setTts(message.on, message.voice);
      case 'credits': {
        const { token, ...rest } = await settings();
        if (!token) return { ok: false, missing: false, message: 'no token' };
        return fetchCredits(effectiveConfig(rest), token);
      }
      case 'end':
        await broadcaster.end();
        return null;
      case 'dismiss':
        await broadcaster.dismiss();
        return null;
    }
  };
  handle().then(reply, (e: unknown) => reply({ ok: false, error: 'network', message: String(e) }));
  return true; // reply asynchronously
});

// Closing the Abestar tab ends the broadcast. Quitting Chrome may not leave time for that; the session left behind
// is ended when the worker next starts (Chrome restarted), as is one whose end could not reach the server.
chrome.tabs.onRemoved.addListener((tabId) => void broadcaster.tabClosed(tabId));
void broadcaster.endLeftover();

// Safety net for retries if Chrome stopped the worker while lines were queued, or an end did not reach the server.
chrome.alarms.create('flush', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'flush') return;
  void broadcaster.flush();
  void broadcaster.endLeftover();
});

// Abestar hosts added on the options page get the content script too.
async function registerExtraHosts() {
  const { extraHosts = [] } = await settings();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['extra-hosts'] });
  if (existing.length > 0)
    await chrome.scripting.unregisterContentScripts({ ids: ['extra-hosts'] });
  if (extraHosts.length === 0) return;
  await chrome.scripting.registerContentScripts([
    { id: 'extra-hosts', matches: extraHosts, js: ['content.js'], runAt: 'document_idle' },
  ]);
}
chrome.runtime.onInstalled.addListener(() => void registerExtraHosts());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'extraHosts' in changes) void registerExtraHosts();
});
