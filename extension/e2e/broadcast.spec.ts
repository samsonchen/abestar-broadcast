// M3 end to end: the built extension (local target) captures the mock Abestar page and writes to the
// local Supabase; a viewer reads the rows with the PIN (PLAN.md §4.6, §8).
import { createClient } from '@supabase/supabase-js';
import { test as base, chromium, expect, type BrowserContext, type Worker } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '../dist/local');
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
        .select('epoch, seq, text')
        .order('epoch')
        .order('seq');
      return data ?? [];
    },
  };
}

test('broadcasts the mock session, survives a reload, and ends', async ({
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
  await popup.locator('#start').click();
  await expect(popup.locator('#status')).toHaveText('● Live');
  const pin = (await popup.locator('#pin').textContent())?.trim() ?? '';
  expect(pin).toMatch(/^\d{6}$/);
  await expect(popup.locator('#link')).toHaveText(
    `http://localhost:5173/abestar-broadcast/?pin=${pin}`,
  );

  const audience = await viewer(pin);
  expect(audience.joined).toMatchObject({ session: { status: 'live' } });

  // The recorded session, replayed by the mock.
  await abestar.locator('#play').click();
  await expect
    .poll(async () => (await audience.rows()).map((r) => r.text), { timeout: 40_000 })
    .toEqual([
      'Chinese test, testing translation.',
      'Come and check out the Furry Kid Market.',
      'Healthy and flexible for brisk walking, or enhanced maintenance for joint degeneration warnings.',
      'Pet joint health self-assessment form.',
    ]);
  const firstEpoch = (await audience.rows())[0]?.epoch ?? -1;
  await expect(popup.locator('#counts')).toHaveText('4 lines sent');

  // The presenter reloads Abestar: numbering restarts at 1, earlier lines must stay.
  await abestar.reload();
  await abestar.locator('#add').click();
  await abestar.locator('#text').fill('After the reload.');
  await abestar.locator('#resolve').click();
  await expect.poll(async () => (await audience.rows()).length, { timeout: 15_000 }).toBe(5);
  const rows = await audience.rows();
  expect(rows.slice(0, 4).every((r) => r.epoch === firstEpoch)).toBe(true);
  expect(rows[4]).toMatchObject({ seq: 1, text: 'After the reload.' });
  expect(rows[4]?.epoch).toBeGreaterThan(firstEpoch);

  // End: the PIN stops working.
  await popup.locator('#end').click();
  await expect(popup.locator('#idle')).toBeVisible();
  expect((await viewer(pin)).joined).toEqual({ error: 'invalid_pin' });
  expect(await audience.rows()).toEqual([]); // when it ends, it ends
});
