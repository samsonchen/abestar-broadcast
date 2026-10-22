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

/** Keeps the screen on while wanted; Chrome and Safari drop the lock when the page is hidden. */
export function wakeLock() {
  let wanted = false;
  let lock: WakeLockSentinel | null = null;
  const acquire = async () => {
    if (!wanted || lock || document.visibilityState !== 'visible' || !('wakeLock' in navigator))
      return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } catch {
      // unsupported or refused (low battery); the screen may sleep
    }
  };
  document.addEventListener('visibilitychange', () => void acquire());
  return {
    set(on: boolean) {
      wanted = on;
      if (on) void acquire();
      else void lock?.release();
    },
  };
}
