// Messages between the extension's parts. Content → background capture messages are in @abestar/shared.

import type { CaptureMessage } from '@abestar/shared';

/** Background → content script. */
export type ToContent =
  | { kind: 'ping' }
  | { kind: 'start'; includeExisting: boolean; debounceMs: number }
  | { kind: 'stop' };

/** Content script / popup → background. */
export type ToBackground =
  | { kind: 'hello' }
  | { kind: 'capture'; message: CaptureMessage }
  | { kind: 'start'; tabId: number; title: string; includeExisting: boolean; force: boolean }
  | { kind: 'end' }
  | { kind: 'dismiss' };

/** Reply to `hello`: whether this tab should capture (it is the broadcasting tab, e.g. after a reload). */
export type HelloReply =
  { capture: false } | { capture: true; includeExisting: boolean; debounceMs: number };

export type StartError =
  'no-token' | 'invalid-token' | 'session-live' | 'busy' | 'not-abestar' | 'network';

export type StartReply = { ok: true } | { ok: false; error: StartError; message?: string };

export type Status =
  | 'idle'
  | 'live'
  | 'reconnecting'
  | 'column-not-found'
  | 'tab-closed'
  | 'ended-remotely'
  | 'invalid-token';

export interface Broadcast {
  sessionId: string;
  pin: string;
  title: string;
  tabId: number;
  epoch: number;
  startedAt: number;
}

/** Kept in chrome.storage.session under `state`; the popup renders it. */
export interface BroadcastState {
  broadcast: Broadcast | null;
  status: Status;
  sent: number;
  queued: number;
  lastError: string | null;
}

export const IDLE_STATE: BroadcastState = {
  broadcast: null,
  status: 'idle',
  sent: 0,
  queued: 0,
  lastError: null,
};
