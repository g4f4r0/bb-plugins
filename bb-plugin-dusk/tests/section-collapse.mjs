import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Exercise the real sidebar and navigation with isolated status/snooze fixtures.
const browser = await chromium.launch({ executablePath: process.env.DUSK_BROWSER, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem('dusk:status-collapsed')) localStorage.setItem('dusk:status-collapsed', '[]');
  });
  let ids;
  let resolveIds;
  const idsReady = new Promise(resolve => { resolveIds = resolve; });
  await context.route('**/api/v1/sidebar-bootstrap', async route => {
    const data = await (await route.fetch()).json();
    const samples = [data.personalProject, ...data.projects].flatMap(p => p.threads).filter(t => !t.parentThreadId).slice(0, 3);
    assert.equal(samples.length, 3, 'Requires three existing thread routes');
    ids = samples.map(t => t.id);
    resolveIds();
    for (const project of [data.personalProject, ...data.projects]) project.threads = [];
    data.personalProject.threads = samples.map((thread, i) => ({ ...thread,
      projectId: data.personalProject.id, title: `Section fixture ${i}`, parentThreadId: null,
      status: 'idle',
      runtime: { displayStatus: 'idle', hostReconnectGraceExpiresAt: null },
      activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: i === 0 ? 1 : 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
      queuedWork: 'none', hasPendingInteraction: false, pinnedAt: null,
      latestAttentionAt: 0, lastReadAt: Date.now(), updatedAt: Date.now(),
    }));
    await route.fulfill({ json: data });
  });
  await context.route('**/api/v1/plugins/dusk/rpc/*', async route => {
    const method = route.request().url().split('/').pop();
    if (method === 'snoozes') await idsReady;
    const result = method === 'snoozes' ? [{ threadId: ids[2], at: Date.now(), until: Date.now() + 3600000 }]
      : method === 'get' ? { image: null } : [];
    await route.fulfill({ json: { ok: true, result } });
  });
  // Navigation must not mark actual threads read or write UI preferences.
  await context.route('**/api/v1/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method()) && !route.request().url().includes('/plugins/dusk/rpc/')) {
      await route.fulfill({ json: {} });
    } else await route.fallback();
  });
  const page = await context.newPage();
  page.on('pageerror', error => console.error(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto(process.env.BB_TEST_URL || 'http://127.0.0.1:38886', { waitUntil: 'domcontentloaded' });
  const heading = section => page.locator(`.dusk-status-heading[data-section="${section}"]`);
  await heading('snoozed').waitFor().catch(async error => { await page.getByText('Error details', { exact: true }).click().catch(() => {}); console.log(await page.locator('body').innerText()); throw error; });
  const select = async i => {
    await page.locator(`[data-sidebar-thread-id="${ids[i]}"]`).click();
    await page.waitForFunction(id => location.pathname.includes(id), ids[i]);
  };
  await select(2);
  await heading('snoozed').click();
  assert.equal(await heading('snoozed').getAttribute('aria-expanded'), 'false', 'Active snoozed group must close on the first click');
  await heading('snoozed').click();
  for (let i = 0; i < 6; i++) await heading('snoozed').click();
  assert.equal(await heading('snoozed').getAttribute('aria-expanded'), 'true');
  await select(0);
  await heading('working').click();
  assert.equal(await heading('working').getAttribute('aria-expanded'), 'false', 'Active working group must close');
  await heading('working').click();
  await select(1);
  assert.equal(await heading('working').getAttribute('aria-expanded'), 'true', 'Leaving a working thread must not close its group');
  await select(0);
  await heading('working').click();
  await select(1);
  assert.equal(await heading('working').getAttribute('aria-expanded'), 'false', 'Navigation must preserve a deliberate collapse');
  await page.reload();
  await heading('working').waitFor();
  assert.equal(await heading('working').getAttribute('aria-expanded'), 'false', 'Collapse persists across reload');
  console.log('PASS: active snoozed/working groups close, rapid toggles and navigation preserve choices, reload persists collapse');
} finally { await browser.close(); }
