import type { Voice } from '@abestar/shared';

// Build-time configuration, injected by build.mjs (`prod` from shared/public-config.json, or `local`).

export interface ExtensionConfig {
  supabaseUrl: string;
  publishableKey: string;
  /** Viewer page; the PIN is appended as `?pin=`. */
  viewerUrl: string;
}

declare const __ABESTAR_CONFIG__: ExtensionConfig;

export const buildConfig: ExtensionConfig = __ABESTAR_CONFIG__;

/** Keys in chrome.storage.local (set on the options page, except `lastTitle`). */
export interface Settings {
  token?: string;
  /** Overrides for the baked-in values; empty means "use the build's". */
  supabaseUrl?: string;
  publishableKey?: string;
  viewerUrl?: string;
  /** Extra Abestar URL match patterns, e.g. `https://go.abestar.com.tw/presentation/*`. */
  extraHosts?: string[];
  debounceMs?: number;
  /** The popup's title field, remembered across broadcasts. */
  lastTitle?: string;
  /** The popup's read-aloud voice, remembered across broadcasts. */
  voice?: Voice;
  /**
   * The live session, kept here as well as in session storage: Chrome clears session storage when it restarts (and
   * when the extension is reloaded or updated), and this is how the worker then finds the session to end it.
   */
  liveSessionId?: string;
}

export const DEFAULT_VOICE: Voice = 'female';

export const DEFAULT_DEBOUNCE_MS = 400;

export function effectiveConfig(settings: Settings): ExtensionConfig {
  return {
    supabaseUrl: settings.supabaseUrl || buildConfig.supabaseUrl,
    publishableKey: settings.publishableKey || buildConfig.publishableKey,
    viewerUrl: settings.viewerUrl || buildConfig.viewerUrl,
  };
}

export function viewerLink(viewerUrl: string, pin: string): string {
  const url = new URL(viewerUrl);
  url.searchParams.set('pin', pin);
  return url.toString();
}
