import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BB_TEST_URL || 'http://127.0.0.1:38886';
const artifacts = process.env.DUSK_ARTIFACTS || new URL('../validation/artifacts/', import.meta.url).pathname;
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.DUSK_BROWSER, args: ['--no-sandbox'] });
try {
 const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
 let config = { image: null };
 await context.route('**/api/v1/plugins/dusk/rpc/*', route => {
  const method=route.request().url().split('/').pop();
  if(method==='save')config=route.request().postDataJSON();
  return route.fulfill({json:{ok:true,result:['get','save'].includes(method)?config:[]}});
 });
 await context.route('**/api/v1/**', route => ['GET','HEAD'].includes(route.request().method()) || route.request().url().includes('/plugins/dusk/rpc/') ? route.fallback() : route.fulfill({json:{}}));
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('.dusk-wallpaper[data-ready]').waitFor();
 const edit=page.getByRole('button',{name:'Edit background',exact:true});await edit.waitFor();
 const wallpaper=page.locator('.dusk-wallpaper');
 const initial=await wallpaper.evaluate(c=>c.toDataURL());await page.waitForTimeout(180);
 assert.notEqual(await wallpaper.evaluate(c=>c.toDataURL()),initial);
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(100);
 const still=await wallpaper.evaluate(c=>c.toDataURL());await page.waitForTimeout(180);assert.equal(await wallpaper.evaluate(c=>c.toDataURL()),still);
 await page.evaluate(()=>document.documentElement.style.setProperty('--primary','#00d080'));await page.waitForTimeout(250);
 assert.notEqual(await wallpaper.evaluate(c=>c.toDataURL()),still);
 await page.evaluate(()=>document.documentElement.style.removeProperty('--primary'));
 await page.emulateMedia({reducedMotion:'no-preference'});
 const editor=page.locator('[id="root-compose-prompt"]');await editor.fill('Dusk isolated regression draft');
 await editor.evaluate(el=>window.originalDuskEditor=el);
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=800;c.height=600;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,800,600);g.addColorStop(0,'#153c2b');g.addColorStop(1,'#c2d484');x.fillStyle=g;x.fillRect(0,0,800,600);return c.toDataURL().split(',')[1]});
 await edit.click();const chosen=page.waitForEvent('filechooser');await page.getByRole('menuitem',{name:'Choose image',exact:true}).click();
 await (await chosen).setFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.locator('.dusk-photo-surface[data-ready]').waitFor();await page.waitForTimeout(300);
 assert(config.image.startsWith('data:image/webp;base64,'));assert(config.image.length<=220000);
 assert.equal(await editor.evaluate(el=>el===window.originalDuskEditor),true);assert.match(await editor.innerText(),/isolated regression draft/);
 assert.equal(await page.locator('.dusk-photo-surface').count(),1);assert.equal(await page.locator('.dusk-photo-fade').count(),0);
 await page.screenshot({path:`${artifacts}/photo-direct.png`});
 await page.evaluate(()=>document.documentElement.classList.toggle('dark'));await page.waitForTimeout(350);
 assert.equal(await page.locator('.dusk-photo-surface').count(),1);
 for(const width of [1100,800,360,1440]){await page.setViewportSize({width,height:960});await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('.dusk-photo-surface').count(),1);}
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(100);
 const photoStill=await page.locator('.dusk-photo-surface').evaluate(c=>c.toDataURL());await page.waitForTimeout(150);assert.equal(await page.locator('.dusk-photo-surface').evaluate(c=>c.toDataURL()),photoStill);
 await edit.click();await page.getByRole('menuitem',{name:'Remove image',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.dusk-photo-surface'));
 assert.equal(config.image,null);assert.equal(await wallpaper.evaluate(c=>getComputedStyle(c).visibility),'visible');
 await page.reload();await edit.waitFor();assert.equal(await wallpaper.count(),1);
 assert.deepEqual(errors,[]);await context.close();
 const offline=await browser.newContext();
 await offline.route('**/api/v1/plugins/dusk/rpc/get',route=>route.abort('internetdisconnected'));
 const offlinePage=await offline.newPage();await offlinePage.goto(base);await offlinePage.locator('.dusk-wallpaper[data-ready]').waitFor();
 assert.equal(await offlinePage.locator('.dusk-wallpaper').count(),1);await offline.close();
 console.log('PASS: ambient motion, palette/reduced motion, photo upload/removal, GPU surface, theme/resize, editor identity, refresh, offline fallback and 360px bounds');
} finally { await browser.close(); }
