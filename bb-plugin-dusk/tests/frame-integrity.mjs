import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({executablePath:process.env.DUSK_BROWSER,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:960}});
 await page.route('**/api/v1/plugins/dusk/rpc/get',async r=>{await new Promise(done=>setTimeout(done,600));await r.fulfill({json:{ok:true,result:{image:null}}})});
 await page.goto(process.env.BB_TEST_URL||'http://127.0.0.1:38886');await page.locator('.dusk-wallpaper[data-ready]').waitFor();
 await page.evaluate(()=>{
  window.frameAudit={samples:0,blank:0};window.auditRunning=true;
  function sample(){const c=document.querySelector('.dusk-wallpaper[data-ready]');if(c){window.frameAudit.samples++;if(c.getContext('2d').getImageData(0,0,1,1).data[3]!==255)window.frameAudit.blank++}if(window.auditRunning)requestAnimationFrame(sample)}requestAnimationFrame(sample);
  window.auditTimer=setInterval(()=>document.querySelector('[data-sidebar="trigger"]')?.click(),60);
 });
 for(let i=0;i<16;i++){
  await page.setViewportSize({width:1440-i*32,height:960-i*10});
  if(i===7)await page.evaluate(()=>document.documentElement.classList.toggle('dark'));
 }
 await page.evaluate(()=>clearInterval(window.auditTimer));await page.waitForTimeout(350);
 const result=await page.evaluate(()=>{window.auditRunning=false;return window.frameAudit});
 assert(result.samples>10);assert.equal(result.blank,0);
 console.log('PASS: no blank ready frames during rapid toggle + resize + theme change',JSON.stringify(result));
}finally{await browser.close()}
