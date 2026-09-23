import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:38886');
 await page.locator('.dusk-thread-meta time').first().waitFor();
 const rows=page.locator('[data-dusk-thread-row]');assert(await rows.count()>0);
 const info=await rows.evaluateAll(ns=>ns.map(n=>{const title=n.querySelector('.bb-thread-title').getBoundingClientRect(),meta=n.querySelector('.dusk-thread-meta').getBoundingClientRect(),r=n.getBoundingClientRect();return {topGap:title.top-r.top,bottomGap:r.bottom-meta.bottom,titleBottom:title.bottom,metaTop:meta.top,metaBottom:meta.bottom,rowBottom:r.bottom,count:n.querySelectorAll('.dusk-thread-meta').length};}));
 for(const r of info){assert.equal(r.topGap,6,'Title has 6px top inset');assert.equal(r.bottomGap,6,'Metadata has 6px bottom inset');assert(r.metaTop>=r.titleBottom);assert(r.metaBottom<=r.rowBottom);assert.equal(r.count,1)}
 const expand=page.locator('[data-sidebar="sidebar"] button[aria-label^="Expand "][aria-label$=" threads"]');
 if(await expand.count()) await expand.first().click();
 const overlap=await page.evaluate(()=>{const rs=[...document.querySelectorAll('[data-dusk-thread-row]')].map(n=>n.getBoundingClientRect());for(let i=0;i<rs.length-1;i++) if(rs[i+1].top<rs[i].bottom-0.5) return {i,px:+(rs[i].bottom-rs[i+1].top).toFixed(1),a:rs[i].height,b:rs[i+1].height};return null;});
 assert.equal(overlap,null,'Parent and child thread rows must not overlap');
 const metaFit=await page.evaluate(()=>[...document.querySelectorAll('.dusk-thread-meta')].filter(m=>m.getClientRects().length).flatMap(m=>{const icon=m.querySelector('.dusk-thread-loc-icon,svg,[data-icon]'),loc=m.querySelector('.dusk-thread-location'),time=m.querySelector('time');if(!icon||!loc||!time) return [];const i=icon.getBoundingClientRect(),l=loc.getBoundingClientRect(),t=time.getBoundingClientRect(),mr=m.getBoundingClientRect();return (i.right>l.left+0.5||l.right>t.left+0.5||t.right>mr.right+0.5)?[{iconOverText:i.right>l.left+0.5,textOverTime:l.right>t.left+0.5,timeOverMeta:t.right>mr.right+0.5}]:[];})[0]??null);
 assert.equal(metaFit,null,'Location icon, branch, and time must not overlap');
 const metaPack=await page.evaluate(()=>[...document.querySelectorAll('.dusk-thread-meta')].filter(m=>m.getClientRects().length).flatMap(m=>{const loc=m.querySelector('.dusk-thread-location'),time=m.querySelector('time');if(!loc||!time) return [];if(loc.offsetWidth<loc.scrollWidth) return [];const t=time.getBoundingClientRect(),l=loc.getBoundingClientRect(),mr=m.getBoundingClientRect();return (t.left-l.right>18||mr.right-t.right<24)?[{loc:loc.textContent,locToTime:+(t.left-l.right).toFixed(1),timeToEnd:+(mr.right-t.right).toFixed(1)}]:[];})[0]??null);
 assert.equal(metaPack,null,'Short locations keep time packed, not right-aligned');
 const longEnd=await page.evaluate(()=>[...document.querySelectorAll('.dusk-thread-meta')].filter(m=>m.getClientRects().length).flatMap(m=>{const loc=m.querySelector('.dusk-thread-location'),time=m.querySelector('time'),row=m.closest('[data-dusk-thread-row]');if(!loc||!time||!row||loc.offsetWidth>=loc.scrollWidth) return [];const gap=row.getBoundingClientRect().right-time.getBoundingClientRect().right;return (gap<7.5||gap>12)?[{gap:+gap.toFixed(1)}]:[];})[0]??null);
 assert.equal(longEnd,null,'Long branches end 8px inside the row’s right edge');
 const navH=await page.evaluate(()=>{const sidebar=document.querySelector('[data-sidebar="sidebar"]');const hit=re=>{const el=[...sidebar.querySelectorAll('a,button')].find(e=>re.test((e.textContent||'').replace(/\\s+/g,' ').trim()));return el?Math.round(el.getBoundingClientRect().height):null};return {mcps:hit(/^Search threads/),thread:hit(/.*/)?Math.round(document.querySelector('[data-dusk-thread-row]').getBoundingClientRect().height):null,rowToken:getComputedStyle(sidebar).getPropertyValue('--bb-sidebar-row-height').trim()};});
 assert.equal(navH.thread,48);assert.equal(typeof navH.mcps,'number');assert.ok(navH.mcps<40,'Nav rows must keep native height');assert.equal(navH.rowToken,'1.75rem');
 // BB replaces className when selection/read state changes. Track every frame.
 await page.evaluate(() => {
   window.rowHeights = []; window.sampleRows = true;
   const sample = () => { if (!window.sampleRows) return;
     document.querySelectorAll('[data-dusk-thread-row]').forEach(n => window.rowHeights.push(n.getBoundingClientRect().height));
     requestAnimationFrame(sample);
   }; requestAnimationFrame(sample);
 });
 const links = page.locator('[data-dusk-thread-row] a[data-sidebar-thread-id]');
 await links.nth(0).click(); await page.waitForTimeout(200);
 await links.nth(1).click(); await page.waitForTimeout(200);
 const heights = await page.evaluate(() => { window.sampleRows = false; return window.rowHeights; });
 assert(heights.length > 0 && heights.every(h => h === 48), 'Selection must never collapse the two-line rows');
 const calls=[];
 await page.route(/\/api\/v1\/threads\/[^/]+\/(?:unpin|pin)$/,async route=>{calls.push(route.request().url());await route.fulfill({status:500,json:{error:'QA: simulated failure; no pin changed'}})});
 for(const label of ['Pin thread','Unpin thread']){
  const button=page.getByRole('button',{name:label,exact:true}).first();assert(await button.count());
  const row=button.locator('xpath=ancestor::*[@data-dusk-thread-row]');
  await row.hover();const before=page.url();
  const geo=await row.evaluate(n=>{const pin=n.querySelector('.dusk-pin-slot button').getBoundingClientRect(),archive=n.querySelector('button[aria-label="Archive thread"]').getBoundingClientRect(),title=n.querySelector('.bb-thread-title').getBoundingClientRect();return {pinRight:pin.right,archiveLeft:archive.left,pinWidth:pin.width,archiveWidth:archive.width,titleRight:title.right,pinLeft:pin.left,titleMask:getComputedStyle(n.querySelector('.bb-thread-title')).maskImage}});
  assert(geo.pinRight<=geo.archiveLeft);assert.equal(geo.pinWidth,geo.archiveWidth);assert(geo.titleMask.includes('linear-gradient'),'Title must fade behind the action area');
  await button.click();await page.waitForTimeout(700);assert.equal(page.url(),before,'Pin must not navigate');
 }
 assert(calls.some(x=>x.endsWith('/pin')));assert(calls.some(x=>x.endsWith('/unpin')));
 await page.setViewportSize({width:900,height:800});await page.waitForTimeout(250);
 assert(await page.locator('.dusk-thread-meta').count()>0);
 await page.screenshot({path:'/tmp/dusk-sidebar-details-hover.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS real sidebar metadata, no title overlap, native pin/unpin routing with failure rollback, action order/size, no navigation, responsive rendering');
}finally{await browser.close()}
