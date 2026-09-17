import {chromium} from 'playwright';
import {writeFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:process.env.DUSK_BROWSER,args:['--no-sandbox']});
const dir=new URL('../validation/artifacts/',import.meta.url);await mkdir(dir,{recursive:true});
try {
 const context=await browser.newContext({viewport:{width:1440,height:960}});
 await context.route('**/api/v1/plugins/dusk/rpc/get',r=>r.fulfill({json:{ok:true,result:{image:null}}}));
 await context.addInitScript(()=>{
  window.renderStats={rects:0,uploads:0};
  const rect=Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect=function(...args){if(this.matches('.dusk-home, [data-sidebar="trigger"]'))window.renderStats.rects++;return rect.apply(this,args)};
  const put=CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData=function(...args){window.renderStats.uploads++;return put.apply(this,args)};
 });
 const p=await context.newPage();await p.goto(process.env.BB_TEST_URL||'http://127.0.0.1:38886');await p.locator('.dusk-wallpaper[data-ready]').waitFor();
 const cdp=await context.newCDPSession(p);const events=[];cdp.on('Tracing.dataCollected',e=>events.push(...e.value));
 await cdp.send('Tracing.start',{categories:'devtools.timeline,v8.execute',transferMode:'ReportEvents'});await cdp.send('Profiler.enable');await cdp.send('Profiler.start');
 await p.waitForTimeout(2000);
 for(let i=0;i<20;i++)await p.setViewportSize({width:1440-i*15,height:960-i*5});
 await p.waitForTimeout(300);
 for(let i=0;i<4;i++){await p.locator('[data-sidebar="trigger"]:visible').first().click();await p.waitForTimeout(300);}
 const {profile}=await cdp.send('Profiler.stop');const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');await done;
 const name=process.env.DUSK_LABEL||'render-baseline';
 await writeFile(new URL(`${name}.trace.json`,dir),JSON.stringify({traceEvents:events}));await writeFile(new URL(`${name}.cpuprofile`,dir),JSON.stringify(profile));
 const nodes=new Map(profile.nodes.map(n=>[n.id,n]));const sums=new Map();profile.samples.forEach((id,i)=>{const n=nodes.get(id);const k=`${n.callFrame.functionName} ${n.callFrame.url}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`;sums.set(k,(sums.get(k)||0)+profile.timeDeltas[i]/1000)});
 console.log(JSON.stringify({stats:await p.evaluate(()=>window.renderStats),hot:[...sums].sort((a,b)=>b[1]-a[1]).slice(0,15)},null,2));
}finally{await browser.close()}
