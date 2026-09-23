import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { useStatusList } from './status-list-preference.mjs';
const browser = await chromium.launch({ executablePath: process.env.DUSK_BROWSER, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await useStatusList(page);
  let requests = 0;
  let releaseDetails;
  const detailsReady = new Promise(resolve => { releaseDetails = resolve; });
  await page.route('**/api/v1/plugins/dusk/rpc/threadDetails', async route => {
    requests++;
    await detailsReady;
    await route.fulfill({ json: { ok: true, result: { model: 'Hover regression model', reasoning: 'high', provider: 'Test', modelProviderId: null, fullTitle: 'Hover regression title' } } });
  });
  await page.goto(process.env.BB_TEST_URL || 'http://127.0.0.1:38886');
  const row = page.locator('.dusk-status-row').first();
  await row.waitFor();
  const threadId = await row.locator('.dusk-status-link').getAttribute('data-sidebar-thread-id');
  await row.evaluate(element => { window.originalHoverRow = element; });
  await row.locator('.dusk-status-link').hover();
  const card = page.locator('.dusk-card-popover[data-state="open"]');
  await card.waitFor();
  const skeleton = card.getByRole('status', { name: 'Loading model' });
  await skeleton.waitFor();
  await page.waitForTimeout(250); // Let the popover's entrance animation settle.
  const loadingBox = await card.locator('.dusk-card-fact').first().boundingBox();
  releaseDetails();
  await card.getByText('Hover regression model', { exact: true }).waitFor();
  const loadedBox = await card.locator('.dusk-card-fact').first().boundingBox();
  console.log(JSON.stringify({ loadingBox, loadedBox }));
  assert.equal(loadingBox.height, loadedBox.height, 'Model row must reserve its loaded height');
  assert.equal(loadingBox.y, loadedBox.y, 'Model row must not move when details arrive');
  const geometry = await card.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + Math.min(30, rect.height / 2);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      hit: document.elementsFromPoint(x, y).some(node => node === element || element.contains(node)),
      insideVirtualRow: !!element.closest('.dusk-virtual-item') };
  });
  console.log(JSON.stringify({ requests, ...geometry }));
  assert(geometry.hit, 'Hover details must be painted and hit-testable outside the sidebar');
  assert.equal(geometry.insideVirtualRow, false, 'Popover must escape the contained virtual row');
  assert.equal(requests, 1);
  await page.mouse.move(geometry.x + 20, geometry.y + 20);
  await page.waitForTimeout(120);
  assert.equal(await card.count(), 1, 'Popover stays open when moving onto its content');
  await page.mouse.move(1200, 800);
  await card.waitFor({ state: 'hidden' });
  const heading = page.locator('.dusk-status-heading').first();
  await heading.click();
  await page.waitForFunction(() => !window.originalHoverRow.isConnected);
  await heading.click();
  await page.evaluate(() => {
    window.loadingFlashes = 0;
    window.loadingObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('[role="status"][aria-label="Loading model"]') || node.querySelector('[role="status"][aria-label="Loading model"]'))) window.loadingFlashes++;
      }
    });
    window.loadingObserver.observe(document.body, { childList: true, subtree: true });
  });
  await page.locator(`[data-sidebar-thread-id="${threadId}"]`).hover();
  await card.getByText('Hover regression model', { exact: true }).waitFor();
  assert.equal(requests, 1, 'Remounted rows reuse the cached model without another RPC');
  assert.equal(await page.evaluate(() => { window.loadingObserver.disconnect(); return window.loadingFlashes; }), 0, 'Cached cards must not insert a loading placeholder');
  console.log('PASS: stable loading geometry, visible interactive card, and immediate cached details after remount');
} finally { await browser.close(); }
