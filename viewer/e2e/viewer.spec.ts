// M4 end to end: the viewer against the local Supabase stack, on desktop and phone viewports (PLAN.md §5.6).
// A test-side broadcaster writes through the same RPCs as the extension.
import { createClient } from '@supabase/supabase-js';
import { expect, type Page, test } from '@playwright/test';
import local from '../../shared/local-config.json' with { type: 'json' };

const TOKEN = 'local-dev-token'; // seed.sql
const VIEWER = local.viewerUrl;

async function broadcast(title: string, { targetLang = 'en-US', tts = false } = {}) {
  const sb = createClient(local.supabaseUrl, local.publishableKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await sb.rpc('start_session', {
    p_token: TOKEN,
    p_title: title,
    p_target_lang: targetLang,
    p_force: true,
    p_tts: tts,
  });
  if (error) throw error;
  const { id, pin } = data as { id: string; pin: string };
  const call = async (fn: string, args: object) => {
    const { error } = await sb.rpc(fn, { p_token: TOKEN, p_session_id: id, ...args });
    if (error) throw error;
  };
  return {
    pin,
    line: (seq: number, text: string, epoch = 1, lang?: string) =>
      call('upsert_segment', { p_epoch: epoch, p_seq: seq, p_text: text, p_lang: lang ?? null }),
    readAloud: (on: boolean) => call('set_session_tts', { p_on: on, p_voice: 'female' }),
    end: () => call('end_session', {}),
  };
}

const lines = (page: Page) => page.locator('#lines > li');
const status = (page: Page) => page.locator('#status');
const pinError = (page: Page) => page.locator('#pin-error');
const wrongPin = (pin: string) => (pin === '000000' ? '111111' : '000000');

test('follows a broadcast: history, live lines, revisions, reload', async ({ page }) => {
  const b = await broadcast('Quarterly review');
  await b.line(1, 'Good morning, everyone.');
  await b.line(2, 'The cat sat on the mat.');

  await page.goto(`${VIEWER}?pin=${b.pin}`);
  await expect(page.locator('#title')).toHaveText('Quarterly review');
  await expect(lines(page)).toHaveText(['Good morning, everyone.', 'The cat sat on the mat.']);
  await expect(status(page)).toHaveText('Live');

  await b.line(3, 'A new line arrives.');
  await expect(lines(page).nth(2)).toHaveText('A new line arrives.', { timeout: 1000 });

  await b.line(2, 'The dog sat on the red mat.');
  const revised = lines(page).nth(1);
  await expect(revised).toContainText('The dog sat on the red mat.', { timeout: 1000 });
  await expect(revised.locator('mark')).toHaveText(['dog', 'red']);
  await expect(revised.locator('.tag')).toHaveText('revised');

  await page.reload();
  await expect(lines(page)).toHaveCount(3);
  await expect(lines(page).nth(1).locator('mark')).toHaveText(['dog', 'red']);
});

test('PIN dialog: wrong PIN, then the right one', async ({ page }) => {
  const b = await broadcast('Dialog');
  await b.line(1, 'Hello.');

  await page.goto(VIEWER);
  const dialog = page.locator('#pin-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#pin')).toHaveAttribute('inputmode', 'numeric');

  await page.fill('#pin', '12');
  await page.click('#join');
  await expect(pinError(page)).toHaveText('Enter the 6 digits.');

  await page.fill('#pin', wrongPin(b.pin));
  await page.click('#join');
  await expect(pinError(page)).toHaveText('PIN not valid or broadcast has ended.');

  await page.fill('#pin', b.pin);
  await page.click('#join');
  await expect(dialog).toBeHidden();
  await expect(lines(page)).toHaveText(['Hello.']);
  expect(new URL(page.url()).searchParams.get('pin')).toBe(b.pin);
});

test('an ended broadcast keeps its lines on screen, then refuses the PIN', async ({ page }) => {
  const b = await broadcast('Ending');
  await b.line(1, 'Thank you all.');
  await page.goto(`${VIEWER}?pin=${b.pin}`);
  await expect(status(page)).toHaveText('Live');

  await b.end();
  await expect(page.locator('#ended')).toBeVisible();
  await expect(status(page)).toHaveText('Ended');
  await expect(lines(page)).toHaveText(['Thank you all.']);

  await page.reload();
  await expect(pinError(page)).toHaveText('PIN not valid or broadcast has ended.');
  await expect(lines(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('pin')).toBe(false);
});

test('an old PIN does not open the next broadcast', async ({ page }) => {
  const first = await broadcast('Monday meeting');
  const second = await broadcast('Tuesday meeting');
  await second.line(1, 'Not for Monday’s audience.');
  await page.goto(`${VIEWER}?pin=${first.pin}`);
  await expect(pinError(page)).toHaveText('PIN not valid or broadcast has ended.');
  await expect(lines(page)).toHaveCount(0);
});

test('catches up after being offline', async ({ page, context }) => {
  const b = await broadcast('Offline');
  await b.line(1, 'Before the tunnel.');
  await page.goto(`${VIEWER}?pin=${b.pin}`);
  await expect(status(page)).toHaveText('Live');

  await context.setOffline(true);
  await expect(status(page)).toHaveText('Offline');
  await b.line(2, 'In the tunnel.');
  await b.line(1, 'Before the long tunnel.');
  await page.waitForTimeout(1000);
  await expect(lines(page)).toHaveText(['Before the tunnel.']); // nothing reaches an offline page
  await context.setOffline(false);

  await expect(lines(page)).toHaveText(['Before the long tunnel.revised', 'In the tunnel.'], {
    timeout: 15_000,
  });
  await expect(status(page)).toHaveText('Live', { timeout: 15_000 });
});

test('follows new lines at the bottom, and offers a pill after scrolling up', async ({ page }) => {
  const b = await broadcast('Scrolling');
  for (let seq = 1; seq <= 30; seq++) await b.line(seq, `Line number ${seq} of a long talk.`);
  await page.goto(`${VIEWER}?pin=${b.pin}`);
  await expect(lines(page)).toHaveCount(30);
  await expect(lines(page).last()).toBeInViewport();

  await b.line(31, 'Followed automatically.');
  await expect(lines(page).last()).toHaveText('Followed automatically.');
  await expect(lines(page).last()).toBeInViewport();

  await page.evaluate(() => window.scrollTo(0, 0));
  await b.line(32, 'Arrives while reading back.');
  const pill = page.locator('#new-lines');
  await expect(pill).toBeVisible();
  await expect(lines(page).last()).not.toBeInViewport();
  await pill.click();
  await expect(lines(page).last()).toBeInViewport();
  await expect(pill).toBeHidden();
});

test('text size and theme are remembered, without horizontal scrolling', async ({ page }) => {
  const b = await broadcast('Preferences');
  await b.line(1, 'Readable from the back row.');
  await page.goto(`${VIEWER}?pin=${b.pin}`);
  const size = () =>
    lines(page)
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize);
  await expect.poll(size).toBe('20px');

  await page.click('#larger');
  await page.click('#larger');
  await page.click('#theme'); // auto → light
  await page.click('#theme'); // light → dark
  await page.reload();
  await expect.poll(size).toBe('24px');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('read-aloud: offered when the broadcaster turns it on, for English only, off until tapped, marks the line being read', async ({
  page,
}) => {
  // Count the clips that were decoded and started (the local ElevenLabs stub returns a short beep).
  await page.addInitScript(() => {
    const w = window as unknown as { played: number };
    w.played = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if ((this.buffer?.length ?? 0) > 1) w.played++; // not the 1-sample unlock
      return start.apply(this, args);
    };
  });
  const played = () => page.evaluate(() => (window as unknown as { played: number }).played);

  const plain = await broadcast('Plain talk'); // the broadcaster left read-aloud off
  await plain.line(1, 'Good morning.');
  await page.goto(`${VIEWER}?pin=${plain.pin}`);
  await expect(lines(page)).toHaveCount(1);
  await expect(page.locator('#tts')).toBeHidden();

  const japanese = await broadcast('Japanese talk', { targetLang: 'ja-JP', tts: true });
  await japanese.line(1, 'こんにちは。');
  await page.goto(`${VIEWER}?pin=${japanese.pin}`);
  await expect(lines(page)).toHaveCount(1);
  await expect(page.locator('#tts')).toBeHidden();

  const b = await broadcast('English talk', { tts: true });
  await b.line(1, 'Good morning.');
  await page.goto(`${VIEWER}?pin=${b.pin}`);
  const button = page.locator('#tts');
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#tts-hint')).toBeHidden();

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#tts-hint')).toBeVisible();

  // Line 2 is spoken once line 3 arrives (or after a 3 s pause).
  await b.line(2, 'This line is read aloud.');
  await b.line(3, 'And so is this one.');
  await page.waitForFunction(() => document.querySelector('#lines > li.speaking') !== null, null, {
    polling: 'raf',
    timeout: 15_000,
  });
  await expect.poll(played, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#tts-hint')).toBeHidden();
  await expect(page.locator('#lines > li.speaking')).toHaveCount(0);

  // The broadcaster switches read-aloud off and on while live.
  await button.click();
  await b.readAloud(false);
  await expect(button).toBeHidden();
  await expect(page.locator('#tts-hint')).toBeHidden();
  await b.readAloud(true);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  await b.end();
  await expect(button).toBeHidden();
});

test('read-aloud waits while the translation is in another language, then carries on', async ({
  page,
}) => {
  const b = await broadcast('Two languages', { tts: true });
  await b.line(1, 'Good morning.', 1, 'en-US');
  await page.goto(`${VIEWER}?pin=${b.pin}`);
  const button = page.locator('#tts');
  const hint = page.locator('#tts-hint');
  await button.click();
  await expect(hint).toContainText('Read-aloud on');

  await b.line(2, '各位早安。', 1, 'zh-TW'); // the presenter switched Abestar to Chinese
  await expect(hint).toContainText('back in English');
  await expect(button).toHaveAttribute('aria-pressed', 'true');

  await b.line(3, 'Back to English.', 1, 'en-US');
  await expect(hint).toContainText('Read-aloud on');
  await expect(button).toHaveAttribute('aria-pressed', 'true');

  await b.line(4, '再一次中文。', 1, 'zh-TW');
  await expect(hint).toContainText('back in English');
  await button.click(); // off and on: now for Chinese
  await button.click();
  await expect(hint).toContainText('Read-aloud on');
  await b.end();
});

test('?debug shows how the screen is kept on, and released at the end', async ({ page }) => {
  const b = await broadcast('Debug');
  await page.goto(`${VIEWER}?pin=${b.pin}&debug`);
  await expect(page.locator('pre.debug')).toContainText('status: live');
  await expect(page.locator('pre.debug')).toContainText(/screen: (wake lock|video)/);
  await b.end();
  // The phone may sleep again once the broadcast is over.
  await expect(page.locator('pre.debug')).toContainText('screen: off');
});
