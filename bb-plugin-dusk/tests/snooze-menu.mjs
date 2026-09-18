import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// A snooze changes the row's section. The mutation must start only after the
// portalled menu has finished closing, or its detached anchor jumps to (0, 0).
const browser = await chromium.launch({ executablePath: process.env.DUSK_BROWSER, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => localStorage.setItem('dusk:status-collapsed', '[]'));
  const page = await context.newPage();
  let threadId;
  let resolveThreadId;
  const threadReady = new Promise(resolve => { resolveThreadId = resolve; });
  let snoozes = [];
  const mutations = [];

  await page.route('**/api/v1/sidebar-bootstrap', async route => {
    const data = await (await route.fetch()).json();
    const sample = [data.personalProject, ...data.projects].flatMap(project => project.threads).find(thread => !thread.parentThreadId);
    assert(sample, 'Requires one existing thread route');
    threadId = sample.id;
    resolveThreadId();
    for (const project of [data.personalProject, ...data.projects]) project.threads = [];
    data.personalProject.threads = [{
      ...sample,
      projectId: data.personalProject.id,
      title: 'Snooze anchor regression',
      parentThreadId: null,
      status: 'idle',
      runtime: { displayStatus: 'idle', hostReconnectGraceExpiresAt: null },
      activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
      queuedWork: 'none',
      hasPendingInteraction: false,
      pinnedAt: null,
      latestAttentionAt: 0,
      lastReadAt: Date.now(),
      updatedAt: Date.now(),
    }];
    await route.fulfill({ json: data });
  });

  await page.route('**/api/v1/plugins/dusk/rpc/*', async route => {
    const method = route.request().url().split('/').pop();
    if (method === 'snoozes') return route.fulfill({ json: { ok: true, result: snoozes } });
    if (method === 'snooze' || method === 'unsnooze') {
      const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menu"]')).map(element => ({
        state: element.getAttribute('data-state'),
        text: element.textContent,
        rect: element.getBoundingClientRect().toJSON(),
      })));
      mutations.push({ method, menu });
      if (method === 'snooze') {
        const body = route.request().postDataJSON();
        const input = body.input ?? body;
        snoozes = [{ threadId, at: Date.now(), until: input.until }];
      } else snoozes = [];
      return route.fulfill({ json: { ok: true, result: snoozes } });
    }
    const result = method === 'get' ? { image: null } : [];
    await route.fulfill({ json: { ok: true, result } });
  });

  page.on('pageerror', error => console.error(error.message));
  await page.goto(process.env.BB_TEST_URL || 'http://127.0.0.1:38886', { waitUntil: 'domcontentloaded' });
  await threadReady;

  const row = () => page.locator(`.dusk-status-row:has([data-sidebar-thread-id="${threadId}"])`);
  const watchMenuClose = async () => {
    const initial = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"][data-state="open"]');
      if (!(menu instanceof HTMLElement)) throw new Error('Expected an open menu');
      const start = menu.getBoundingClientRect().toJSON();
      const frames = [];
      window.duskMenuCloseFrames = frames;
      window.duskMenuCloseWatch = new Promise(resolve => {
        const deadline = performance.now() + 500;
        const sample = () => {
          const current = document.querySelector('[role="menu"]');
          if (current instanceof HTMLElement) frames.push({
            state: current.dataset.state,
            text: current.textContent,
            rect: current.getBoundingClientRect().toJSON(),
          });
          if (performance.now() < deadline && current) requestAnimationFrame(sample);
          else resolve(frames);
        };
        requestAnimationFrame(sample);
      });
      return { rect: start, text: menu.textContent };
    });
    return async () => ({ initial, frames: await page.evaluate(() => window.duskMenuCloseWatch) });
  };
  const assertAnchored = ({ initial, frames }, operation) => {
    assert(frames.length > 0, `${operation} must observe the closing menu`);
    for (const frame of frames) {
      assert.equal(frame.text, initial.text, `${operation} menu contents must stay stable while closing`);
      const drift = Math.hypot(frame.rect.left - initial.rect.left, frame.rect.top - initial.rect.top);
      assert(drift < 40, `${operation} menu moved ${Math.round(drift)}px while closing: ${JSON.stringify(frame)}`);
    }
  };

  await row().waitFor();
  await row().hover();
  await row().getByRole('button', { name: 'Snooze thread' }).click();
  const snoozeClose = await watchMenuClose();
  await page.getByRole('menuitem', { name: /In 1 hour/ }).click();
  await page.locator('.dusk-status-heading[data-section="snoozed"]').waitFor();
  assertAnchored(await snoozeClose(), 'snooze');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.dusk-card-popover[data-state="open"]').count(), 0, 'snooze must not open the informational hover card');

  await row().hover();
  await row().getByRole('button', { name: 'Snoozed thread' }).click();
  const unsnoozeClose = await watchMenuClose();
  await page.getByRole('menuitem', { name: 'Unsnooze' }).click();
  await page.locator('.dusk-status-heading[data-section="snoozed"]').waitFor({ state: 'detached' });
  assertAnchored(await unsnoozeClose(), 'unsnooze');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.dusk-card-popover[data-state="open"]').count(), 0, 'unsnooze must not open the informational hover card');
  await row().hover();
  await row().getByRole('button', { name: 'Snooze thread' }).waitFor();

  assert.deepEqual(mutations.map(entry => entry.method), ['snooze', 'unsnooze']);
  for (const mutation of mutations) {
    assert.deepEqual(mutation.menu, [], `${mutation.method} must wait until the dropdown portal is gone`);
  }
  console.log('PASS: snooze and unsnooze mutate only after their anchored menu has fully closed');
} finally {
  await browser.close();
}
