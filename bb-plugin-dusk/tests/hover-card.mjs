import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.DUSK_BROWSER, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  let requests = 0;
  await page.route('**/api/v1/plugins/dusk/rpc/threadDetails', async route => {
    requests++;
    await route.fulfill({ json: { ok: true, result: { model: 'Hover regression model', reasoning: 'high', provider: 'Test', modelProviderId: null, fullTitle: 'Hover regression title' } } });
  });
  await page.goto(process.env.BB_TEST_URL || 'http://127.0.0.1:38886');
  const row = page.locator('.dusk-status-row').first();
  await row.waitFor();
  await row.locator('.dusk-status-link').hover();
  const card = page.locator('.dusk-card-popover[data-state="open"]');
  await card.waitFor();
  await card.getByText('Hover regression model', { exact: true }).waitFor();
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
  console.log('PASS: hover details load, escape sidebar clipping, stay interactive and close on leave');
} finally { await browser.close(); }
