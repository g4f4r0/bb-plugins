import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  for (const mobile of [true, false]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 393, height: 852 } : { width: 1440, height: 960 },
      isMobile: mobile, hasTouch: mobile, colorScheme: 'dark', permissions: ['microphone'],
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let gets = 0, saves = 0;
    await page.route('**/api/v1/plugins/dusk/rpc/get', async route => {
      gets++;
      await route.fulfill({ json: { ok: true, result: { image: null } } });
    });
    await page.route('**/api/v1/plugins/dusk/rpc/save', async route => {
      saves++;
      await route.fulfill({ json: { ok: true, result: route.request().postDataJSON() } });
    });
    await page.goto(process.env.BB_TEST_URL || 'http://127.0.0.1:38886');
    await page.waitForTimeout(1200);
    if (!await page.locator('#root-compose-prompt').count())
      await page.getByText('New thread', { exact: true })[mobile ? 'last' : 'first']().click();
    await page.locator('.dusk-wallpaper[data-ready]').waitFor();
    if (mobile) await page.locator('[data-root-compose-mobile-recents] .dusk-thread-meta').first().waitFor();
    await page.locator('[aria-label="Edit background"]').click();
    await page.getByRole('menuitem').first().waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const canvas = await page.locator('.dusk-wallpaper').evaluate(el => ({ width: el.width, expected: Math.round(Math.max(1, el.clientWidth) * Math.min(0.5, 2400 / el.clientWidth, 1800 / el.clientHeight)) }));
    assert.equal(canvas.width, canvas.expected, 'Wallpaper must render at its styled size after cold load');
    assert.equal(gets, 1, 'Opening the background menu must not start a second settings read');

    const measure = el => {
      const r = el.getBoundingClientRect(), f = el.closest('form').getBoundingClientRect();
      return { width: r.width, height: r.height, right: f.right - r.right, bottom: f.bottom - r.bottom };
    };
    for (const home of [true, false]) {
      if (!home) {
        const link = page.locator(mobile ? '[data-root-compose-mobile-recents] a' : '[data-sidebar-thread-id]').first();
        await link.click();
        await page.locator('.dusk-background-header-action').waitFor({ state: 'detached' });
      }
      await page.locator('[contenteditable=true]').first().click();
      await page.waitForFunction(() => {
        const button = document.querySelector('[aria-label="Start voice input"]');
        return button && getComputedStyle(button).getPropertyValue('--dusk-action-size').trim() !== '';
      });
      await page.waitForFunction(size => {
        const r = document.querySelector('[aria-label="Start voice input"]')?.getBoundingClientRect();
        return r?.width === size && r.height === size;
      }, 32);
      const mic = page.locator('[aria-label="Start voice input"]');
      const before = await mic.evaluate(measure);
      assert.equal(before.width, 32);
      assert.equal(before.height, before.width);
      await mic.click();
      const check = page.locator('[aria-label="Stop and transcribe recording"]');
      await check.waitFor();
      await page.waitForTimeout(350);
      const recording = await check.evaluate(measure);
      assert.equal(recording.width, before.width);
      assert.equal(recording.height, before.height);
      assert.equal(recording.bottom, recording.right);
      assert.equal(recording.right, 9);
      await page.screenshot({ path: `/tmp/dusk-review-${mobile ? 'mobile' : 'desktop'}-${home ? 'home' : 'thread'}.png` });
      await page.locator('[aria-label="Cancel recording"]').click();
    }
    assert.equal(saves, 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: single settings read, cold mobile metadata, header menu, navigation cleanup, square mic/recording controls and equal insets on desktop/mobile home/thread; no background writes or page errors.');
} finally {
  await browser.close();
}
