// M3 end to end: the built extension (local target) captures the mock Abestar page and writes to the
// local Supabase; a viewer reads the rows with the PIN (PLAN.md §4.6, §8).
import { createClient } from '@supabase/supabase-js';
import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '../dist/v2-local');
const MOCK = 'http://localhost:5174/mock-abestar.html';
const SUPABASE_URL = 'http://127.0.0.1:54321';
const KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'; // Supabase CLI's fixed local key

const test = base.extend<{ context: BrowserContext; worker: Worker; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
});

/** An audience member: one anonymous sign-in, joined with `pin`. */
async function viewer(pin: string) {
  const sb = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });
  await sb.auth.signInAnonymously();
  const { data: joined } = await sb.rpc('join_session', { p_pin: pin });
  return {
    joined,
    rows: async () => {
      const { data } = await sb
        .from('segments')
        .select('epoch, seq, text, lang')
        .order('epoch')
        .order('seq');
      return data ?? [];
    },
    session: async () => {
      const { data } = await sb
        .from('sessions')
        .select('target_lang, tts_on, tts_lang, tts_voice, tts_release')
        .single();
      return data;
    },
  };
}

/** A line through its whole life on the mock: interim, then draft, then corrected with `text`. */
async function say(abestar: Page, text: string) {
  await abestar.locator('#text').fill(text);
  await abestar.locator('#say').click();
}

test('broadcasts final lines, stays at the latest line, survives a reload, and ends', async ({
  context,
  worker,
  extensionId,
}) => {
  await worker.evaluate(() => chrome.storage.local.set({ token: 'local-dev-token' }));

  const abestar = await context.newPage();
  await abestar.goto(MOCK);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0]?.id,
    'http://localhost:5174/*',
  );

  const popup = await context.newPage();
  popup.on('dialog', (dialog) => void dialog.accept()); // "already live" (seeded demo) and "end?"
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await expect(popup.locator('#title')).toHaveValue(/^Talk \d{4}-\d{2}-\d{2}$/); // nothing typed yet
  await popup.locator('#title').fill('Weekly sync');
  // Read-aloud is off until ticked; the voice choice appears with it.
  await expect(popup.locator('#tts-idle')).not.toBeChecked();
  await expect(popup.locator('input[name="voice-idle"][value="female"]')).toBeHidden();
  await popup.locator('#tts-idle').check();
  await expect(popup.locator('input[name="voice-idle"][value="female"]')).toBeChecked();
  await popup.locator('input[name="voice-idle"][value="male"]').check();
  // The ElevenLabs balance, from the local stub through the Edge Function `tts-credits`.
  await expect(popup.locator('#credits')).toHaveText(
    'ElevenLabs: 8,766 of 10,000 credits left, resets Jan 15',
  );
  await popup.locator('#start').click();
  await expect(popup.locator('#status')).toHaveText('● Live');
  const pin = (await popup.locator('#pin').textContent())?.trim() ?? '';
  expect(pin).toMatch(/^\d{6}$/);
  await expect(popup.locator('#link')).toHaveText(
    `http://localhost:5173/abestar-broadcast/?pin=${pin}`,
  );

  const audience = await viewer(pin);
  expect(audience.joined).toMatchObject({ session: { status: 'live' } });

  // Lines reach the audience only with their final text.
  await say(abestar, 'First line.');
  await expect
    .poll(async () => (await audience.rows()).map((r) => r.text), { timeout: 10_000 })
    .toEqual(['First line.']);
  await say(abestar, 'Second line.');
  await expect
    .poll(async () => (await audience.rows()).map((r) => r.text), { timeout: 10_000 })
    .toEqual(['First line.', 'Second line.']);
  for (const text of ['Third line.', 'Fourth line.']) await say(abestar, text);
  await expect.poll(async () => (await audience.rows()).length, { timeout: 10_000 }).toBe(4);
  expect((await audience.rows()).every((r) => r.lang === 'en')).toBe(true);
  expect((await audience.rows()).every((r) => !r.text.startsWith('Draft'))).toBe(true);

  // A short feed overflows, so scrolling back is possible; the page returns to the latest line after 3 s.
  await abestar.evaluate(async () => {
    const feed = document.querySelector<HTMLElement>('[data-testid="subtitle-feed"]');
    if (feed) {
      feed.style.maxHeight = '60px';
      feed.scrollTop = feed.scrollHeight; // it was at 0, so going to 0 alone would fire no scroll event
      await new Promise(requestAnimationFrame);
      feed.scrollTop = 0;
    }
  });
  await expect(abestar.locator('[data-testid="subtitle-feed"] ~ button')).toBeVisible();
  await expect
    .poll(
      () =>
        abestar.evaluate(() => {
          const c = document.querySelector('[data-testid="subtitle-feed"]') as HTMLElement;
          return c.scrollHeight - c.clientHeight - c.scrollTop;
        }),
      { timeout: 6_000 },
    )
    .toBeLessThanOrEqual(2);
  await expect(abestar.locator('[data-testid="subtitle-feed"] ~ button')).toBeHidden();
  expect(await audience.session()).toEqual({
    target_lang: 'en',
    tts_on: true,
    tts_lang: 'en',
    tts_voice: 'male',
    tts_release: 'final',
  });

  // A second presenter takes over: switch the read-aloud voice while live.
  await expect(popup.locator('input[name="voice-live"][value="male"]')).toBeChecked();
  await popup.locator('input[name="voice-live"][value="female"]').check();
  await expect.poll(async () => (await audience.session())?.tts_voice).toBe('female');
  // …and turn read-aloud off and back on.
  await expect(popup.locator('#tts-live')).toBeChecked();
  await popup.locator('#tts-live').uncheck();
  await expect.poll(async () => (await audience.session())?.tts_lang).toBeNull();
  await expect(popup.locator('input[name="voice-live"][value="female"]')).toBeHidden();
  await popup.locator('#tts-live').check();
  await expect.poll(async () => (await audience.session())?.tts_lang).toBe('en');
  await expect(popup.locator('#counts')).toHaveText('4 lines sent');

  // The presenter reloads Abestar. Nothing is sent twice, and a line that appeared during the reload is recovered.
  await abestar.evaluate(() => {
    const lines = JSON.parse(sessionStorage.getItem('mock-lines') ?? '[]') as unknown[];
    lines.push({ seq: 5, status: 'corrected', text: 'During the reload.', lang: 'en' });
    sessionStorage.setItem('mock-lines', JSON.stringify(lines));
  });
  await abestar.reload();
  await expect.poll(async () => (await audience.rows()).length, { timeout: 15_000 }).toBe(5);
  await say(abestar, 'After the reload.');
  await expect
    .poll(async () => (await audience.rows()).map((r) => r.text), { timeout: 15_000 })
    .toEqual([
      'First line.',
      'Second line.',
      'Third line.',
      'Fourth line.',
      'During the reload.',
      'After the reload.',
    ]);
  expect(new Set((await audience.rows()).map((r) => r.epoch)).size).toBe(1);

  // End: the PIN stops working.
  await popup.locator('#end').click();
  await expect(popup.locator('#idle')).toBeVisible();
  expect((await viewer(pin)).joined).toEqual({ error: 'invalid_pin' });
  expect(await audience.rows()).toEqual([]); // when it ends, it ends

  // The next broadcast offers the last title typed.
  await popup.reload();
  await expect(popup.locator('#title')).toHaveValue('Weekly sync');
  await expect(popup.locator('#tts-idle')).not.toBeChecked(); // off again for every new broadcast
  await popup.locator('#tts-idle').check();
  await expect(popup.locator('input[name="voice-idle"][value="female"]')).toBeChecked();
});

/** Opens the mock Abestar page and starts a broadcast from the popup; returns the PIN. */
async function startBroadcast(context: BrowserContext, worker: Worker, extensionId: string) {
  await worker.evaluate(() => chrome.storage.local.set({ token: 'local-dev-token' }));
  const abestar = await context.newPage();
  await abestar.goto(MOCK);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0]?.id,
    'http://localhost:5174/*',
  );
  const popup = await context.newPage();
  popup.on('dialog', (dialog) => void dialog.accept()); // "already live"
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await popup.locator('#start').click();
  await expect(popup.locator('#status')).toHaveText('● Live');
  const pin = (await popup.locator('#pin').textContent())?.trim() ?? '';
  expect((await viewer(pin)).joined).toMatchObject({ session: { status: 'live' } });
  return { abestar, popup, pin };
}

test('closing the Abestar tab ends the broadcast', async ({ context, worker, extensionId }) => {
  const { abestar, popup, pin } = await startBroadcast(context, worker, extensionId);
  await abestar.close();
  await expect(popup.locator('#ended-text')).toHaveText(
    'The broadcast ended because the Abestar tab was closed.',
  );
  await expect.poll(async () => (await viewer(pin)).joined).toEqual({ error: 'invalid_pin' });
  await popup.locator('#ok').click();
  await expect(popup.locator('#idle')).toBeVisible();
});

test('a broadcast started on the language picker sends no history', async ({
  context,
  worker,
  extensionId,
}) => {
  await worker.evaluate(() => chrome.storage.local.set({ token: 'local-dev-token' }));
  const abestar = await context.newPage();
  await abestar.goto(MOCK);
  await abestar.evaluate(() =>
    sessionStorage.setItem(
      'mock-lines',
      JSON.stringify([{ seq: 1, status: 'corrected', text: 'Old line.', lang: 'en' }]),
    ),
  );
  await abestar.goto(`${MOCK}?picker`);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0]?.id,
    'http://localhost:5174/*',
  );
  const popup = await context.newPage();
  popup.on('dialog', (dialog) => void dialog.accept());
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await popup.locator('#start').click();
  await expect(popup.locator('#status')).toHaveText(/Live|Choose a language/, { timeout: 15_000 });
  const pin = (await popup.locator('#pin').textContent())?.trim() ?? '';
  const audience = await viewer(pin);

  await abestar.locator('#enter-event').click();
  await expect(abestar.getByText('Old line.')).toBeVisible(); // the history batch comes just after the feed
  await say(abestar, 'New line.');
  await expect
    .poll(async () => (await audience.rows()).map((r) => r.text), { timeout: 10_000 })
    .toEqual(['New line.']);
});

test('a line stuck in draft is sent after 10 s', async ({ context, worker, extensionId }) => {
  const { abestar, pin } = await startBroadcast(context, worker, extensionId);
  const audience = await viewer(pin);
  await abestar.locator('#text').fill('Stuck line.');
  await abestar.locator('#stuck').click();
  await expect
    .poll(async () => (await audience.rows()).map((r) => r.text), { timeout: 15_000 })
    .toEqual(['Stuck line.']);
});

test('restarting Chrome ends the broadcast', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'abestar-e2e-'));
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
  const workerOf = async (context: BrowserContext) =>
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  try {
    let context = await launch();
    let worker = await workerOf(context);
    const extensionId = new URL(worker.url()).host;
    const { pin } = await startBroadcast(context, worker, extensionId);
    // Chrome quits (or crashes) before the closing tab can end the session: offline, the end cannot get through.
    await context.setOffline(true);
    await context.close();

    context = await launch();
    worker = await workerOf(context);
    await expect.poll(async () => (await viewer(pin)).joined).toEqual({ error: 'invalid_pin' });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('#ended-text')).toHaveText(/because Chrome restarted/);
    await context.close();
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
