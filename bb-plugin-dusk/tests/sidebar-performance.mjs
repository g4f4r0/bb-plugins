import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.BB_TEST_URL || 'http://127.0.0.1:38886';
const output = new URL('../validation/artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const count = Number(process.env.DUSK_THREADS || 500);
const browser = await chromium.launch({ executablePath: process.env.DUSK_BROWSER, args: ['--no-sandbox'] });
try {
 const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
 await context.route('**/api/v1/sidebar-bootstrap', async route => {
  const data = await (await route.fetch()).json();
  const sample = data.personalProject.threads[0] || data.projects.flatMap(p => p.threads)[0];
  for(const p of data.projects) p.threads=[];
  data.personalProject.threads = Array.from({length:count},(_,i)=>({...sample,id:`thr_duskperf${i}`,projectId:data.personalProject.id,title:`Performance fixture ${i}`,titleFallback:null,parentThreadId:null,status:'idle',activity:{activeBackgroundAgentCount:0,activeBackgroundCommandCount:0,activeGoalCount:0,activePlanModeCount:0,activeWorkflowCount:0},runtime:{displayStatus:'idle',hostReconnectGraceExpiresAt:null},queuedWork:'none',hasPendingInteraction:false,pinnedAt:null,latestAttentionAt:0,lastReadAt:Date.now(),updatedAt:Date.now()-i*60000}));
  await route.fulfill({json:data});
 });
 await context.route('**/api/v1/plugins/dusk/rpc/*', route => {
  const method=route.request().url().split('/').pop();
  return route.fulfill({json:{ok:true,result:method==='get'?{image:null}:method==='threadDetails'?{model:null,reasoning:null,provider:null,modelProviderId:null,fullTitle:null}:[]}});
 });
 // No fixture actions or UI preferences can reach persistent state.
 await context.route('**/api/v1/**', async route=> {
  if(!['GET','HEAD'].includes(route.request().method()) && !route.request().url().includes('/plugins/dusk/rpc/')) return route.fulfill({json:{}});
  await route.fallback();
 });
 const page=await context.newPage(); const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
 const cdp=await context.newCDPSession(page);
 await cdp.send('Tracing.start',{categories:'devtools.timeline,v8.execute,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'});
 await page.goto(base);await page.locator('.dusk-status-list').waitFor();await page.waitForTimeout(1500);
 const rows=await page.locator('.dusk-status-row').count();
 console.log(JSON.stringify({count,rows,buttons:await page.locator('[data-sidebar="trigger"]').count()}));
 await page.evaluate(()=>{window.framesSample=[];window.perfRunning=true;let last=performance.now();function tick(now){window.framesSample.push(now-last);last=now;if(window.perfRunning)requestAnimationFrame(tick)}requestAnimationFrame(tick)});
 for(let i=0;i<8;i++) { await page.locator('[data-sidebar="trigger"]:visible').first().click(); await page.waitForTimeout(300); }
 const frames=await page.evaluate(()=>{window.perfRunning=false;return window.framesSample});
 const completed=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await completed;
 let trace='';for(;;){const chunk=await cdp.send('IO.read',{handle:stream});trace+=chunk.data;if(chunk.eof)break;}await cdp.send('IO.close',{handle:stream});
 const label=process.env.DUSK_LABEL||'baseline';await writeFile(new URL(`${label}-${count}.trace.json`,output),trace);
 const events=JSON.parse(trace).traceEvents;const totals={};for(const e of events)if(e.ph==='X' && ['Layout','UpdateLayoutTree','Paint','FunctionCall','RunTask'].includes(e.name)){const v=totals[e.name]||={count:0,ms:0,max:0};v.count++;v.ms+=(e.dur||0)/1000;v.max=Math.max(v.max,(e.dur||0)/1000);}
 frames.sort((a,b)=>a-b);const result={count,rows,frames:frames.length,p95:frames[Math.floor(frames.length*.95)],max:frames.at(-1),over25:frames.filter(x=>x>25).length,totals,errors};
 await writeFile(new URL(`${label}-${count}.json`,output),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 await page.screenshot({path:new URL(`${label}-${count}.png`,output).pathname});
} finally {await browser.close();}
