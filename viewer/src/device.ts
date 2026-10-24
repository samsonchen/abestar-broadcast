// Per-device conveniences: text size and theme (remembered in localStorage) and the screen wake lock.
import { byId } from './ui';

const SIZE_KEY = 'abestar-viewer-size';
const THEME_KEY = 'abestar-viewer-theme';
const SIZES = [16, 18, 20, 22, 24, 28, 32, 36];
const THEMES = ['auto', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

// Storage can be missing or throw (private mode, blocked site data); the page works without it.
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

export function setUpPreferences(): void {
  const root = document.documentElement;
  let size = Number(load(SIZE_KEY));
  if (!SIZES.includes(size)) size = 20;
  let theme = (load(THEME_KEY) ?? 'auto') as Theme;
  if (!THEMES.includes(theme)) theme = 'auto';

  const smaller = byId<HTMLButtonElement>('smaller');
  const larger = byId<HTMLButtonElement>('larger');
  const themeButton = byId<HTMLButtonElement>('theme');

  const apply = () => {
    root.style.setProperty('--size', `${size}px`);
    smaller.disabled = size === SIZES[0];
    larger.disabled = size === SIZES.at(-1);
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    themeButton.textContent = { auto: '◐', light: '☀', dark: '☾' }[theme];
    themeButton.setAttribute('aria-label', `Theme: ${theme === 'auto' ? 'automatic' : theme}`);
  };
  const step = (by: number) => {
    size = SIZES[Math.min(SIZES.length - 1, Math.max(0, SIZES.indexOf(size) + by))] ?? size;
    save(SIZE_KEY, String(size));
    apply();
  };
  smaller.addEventListener('click', () => step(-1));
  larger.addEventListener('click', () => step(1));
  themeButton.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'auto';
    save(THEME_KEY, theme);
    apply();
  });
  apply();
}

/**
 * Calls `fn` on every tap or click, early (capture phase). Phones treat a touch as a user gesture (needed to play
 * audio or take the wake lock) only when the finger lifts: touchend, not pointerdown.
 */
export function onTap(fn: () => void): void {
  for (const type of ['touchend', 'click'] as const) {
    document.addEventListener(type, fn, { capture: true, passive: true });
  }
}

/**
 * A 2-second blank 16×16 video, no audio (made with ffmpeg). Playing it muted and looped keeps some phones awake
 * where the Wake Lock API is missing (in-app browsers such as LINE's) or refused: the NoSleep.js technique.
 */
const BLANK_VIDEO =
  'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMACDxYuSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApAAAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAChgAAAAoAAAAUc3RjbwAAAAAAAAABAAADWgAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDIAAAAIZnJlZQAAAphtZGF0AAACcAYF//9s3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAA5liIQFv///D0UAAU9/gAAAAAZBmjgK+oA=';

/** How the screen is being kept on, for the `?debug` line. */
export type WakeStatus = string;

/**
 * Keeps the screen on while wanted: the Screen Wake Lock API, else a playing blank video. Browsers drop both when the
 * page is hidden, so they are taken again when it is shown, and on any tap (some only allow it after one).
 * `needsTap` is true while the lock was refused for want of a tap (iPhone Safari, e.g. when opened from a QR code
 * or after unlocking the phone), so the page can ask for one. `?awake=video` uses the video only, to compare.
 */
export function wakeLock(
  onStatus: (status: WakeStatus) => void = () => {},
  onNeedsTap: (on: boolean) => void = () => {},
) {
  const videoOnly = new URLSearchParams(location.search).get('awake') === 'video';
  let wanted = false;
  let tapNeeded = false;
  const needsTap = (on: boolean) => {
    tapNeeded = on;
    onNeedsTap(on);
  };
  let lock: WakeLockSentinel | null = null;
  let requesting = false;
  let video: HTMLVideoElement | null = null;

  const playVideo = async (why: string, tapped: boolean) => {
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('aria-hidden', 'true');
      video.className = 'keep-awake';
      video.src = BLANK_VIDEO;
      document.body.append(video);
    }
    try {
      await video.play();
      if (!wanted) return void video.pause(); // the broadcast ended while starting it
      onStatus(`video (${why})`);
    } catch (e) {
      needsTap(!tapped); // e.g. an in-app browser that plays video only after a tap
      onStatus(`off: ${why}; video refused (${e instanceof Error ? e.name : String(e)})`);
    }
  };

  /** `tapped`: called from a user gesture, which some browsers require for the wake lock. */
  const acquire = async (tapped = false) => {
    if (!wanted || lock || requesting || document.visibilityState !== 'visible') return;
    const videoPlaying = Boolean(video && !video.paused);
    if (videoPlaying && !tapped) return; // the video keeps going; a tap may still get the real lock
    if (videoOnly) return playVideo('?awake=video', tapped);
    if (!('wakeLock' in navigator)) return playVideo('no Wake Lock API', tapped);
    requesting = true;
    try {
      lock = await navigator.wakeLock.request('screen');
      if (!wanted) {
        // the broadcast ended while asking
        void lock.release();
        lock = null;
        return;
      }
      needsTap(false);
      lock.addEventListener('release', () => {
        lock = null;
        onStatus('released');
      });
      video?.pause();
      onStatus(`wake lock${tapped ? ' (after a tap)' : ''}`);
    } catch (e) {
      // e.g. Low Power Mode, low battery, or no gesture yet; the video may still work
      // Only a tap can help with NotAllowedError; after a tap, a refusal is the phone's choice (Low Power Mode).
      needsTap(!tapped && (e as { name?: unknown } | null)?.name === 'NotAllowedError');
      const why = `wake lock refused${tapped ? ' after a tap' : ''}: ${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`;
      if (videoPlaying) onStatus(`video; ${why}`);
      else await playVideo(why, tapped);
    } finally {
      requesting = false;
    }
  };

  document.addEventListener('visibilitychange', () => void acquire());
  onTap(() => void acquire(true));
  return {
    /** The screen is not kept on until the page is tapped. */
    get needsTap(): boolean {
      return tapNeeded;
    },
    set(on: boolean) {
      wanted = on;
      if (on) return void acquire();
      void lock?.release();
      video?.pause();
      needsTap(false);
      onStatus('off');
    },
  };
}
