import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {chromium} from 'playwright';
async function moduleUrl(name) {
 let source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 for(const match of source.matchAll(/from "\.\/(.*?)"/g)) source=source.replace(match[0],`from "${await moduleUrl(match[1])}"`);
 return 'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
}
const browser=await chromium.launch({executablePath:process.env.DUSK_BROWSER,args:['--no-sandbox']});
try {
 const page=await browser.newPage();
 await page.setContent('<main data-testid="app-layout-root"><div data-testid="app-desktop-sidebar-trigger"><button data-sidebar="trigger" style="width:28px;height:28px">toggle</button></div><div id="host" style="width:800px;height:600px"><div data-testid="root-compose-main-window-drag-strip"></div><div id="control"></div></div><div id="stream"></div></main>');
 const header=await moduleUrl('homepage-header');const ambient=await moduleUrl('ambient');
 const result=await page.evaluate(async ({header,ambient})=>{
  let pending=new Set(),observing=new Set(),rects=0;
  const raf=requestAnimationFrame,caf=cancelAnimationFrame;
  window.requestAnimationFrame=fn=>{let id=raf(time=>{pending.delete(id);fn(time)});pending.add(id);return id};
  window.cancelAnimationFrame=id=>{pending.delete(id);caf(id)};
  for(const name of ['MutationObserver','ResizeObserver','IntersectionObserver']) {
   const Original=window[name];window[name]=class extends Original {observe(...args){observing.add(this);return super.observe(...args)}disconnect(){observing.delete(this);return super.disconnect()}};
  }
  const rect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){rects++;return rect.call(this)};
  const pause=()=>new Promise(r=>setTimeout(r,80));
  const {mountHomepageHeader}=await import(header);const host=document.querySelector('#host'),control=document.querySelector('#control');
  const stop=mountHomepageHeader(host,control,document.createElement('div'));
  await pause();const initial=rects;
  for(let i=0;i<1000;i++)document.querySelector('#stream').append(document.createElement('span'));
  await pause();const unrelatedReads=rects-initial;
  stop();await pause();const headerRemaining={frames:pending.size,observers:observing.size,panels:document.querySelectorAll('[data-dusk-panel-toggle]').length};
  const {animateAmbient}=await import(ambient);const canvas=document.createElement('canvas');canvas.width=400;canvas.height=300;document.body.append(canvas);canvas.style.setProperty('--primary','#2383e2');
  const from=document.createElement('canvas');from.width=400;from.height=300;from.getContext('2d').fillRect(0,0,400,300);
  const dispose=animateAmbient(canvas,[255,255,255,255],false,from);
  await pause();Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));await pause();
  const hiddenFrames=pending.size;dispose();await pause();
  return {unrelatedReads,headerRemaining,hiddenFrames,remaining:{frames:pending.size,observers:observing.size}};
 },{header,ambient});
 assert.deepEqual(result,{unrelatedReads:0,headerRemaining:{frames:0,observers:0,panels:0},hiddenFrames:0,remaining:{frames:0,observers:0}});
 console.log('PASS: unrelated mutation isolation; header and ambient observer/frame disposal; hidden-tab suspension');
 const photo=await moduleUrl('photo');
 const photoResult=await page.evaluate(async photo=>{
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  const c=document.createElement('canvas');c.style.cssText='width:800px;height:600px';document.body.append(c);
  const pixels=document.createElement('canvas');pixels.width=80;pixels.height=60;pixels.getContext('2d').fillRect(0,0,80,60);
  const image=new Image();image.src=pixels.toDataURL();await image.decode();
  const {animatePhoto}=await import(photo);const stop=animatePhoto(c,image,pixels);
  await new Promise(r=>setTimeout(r,100));
  const direct=!!document.querySelector('.dusk-photo-surface')&&c.style.visibility==='hidden';
  const surface=document.querySelector('.dusk-photo-surface');
  const gl=surface?.getContext('webgl2');gl?.getExtension('WEBGL_lose_context')?.loseContext();
  await new Promise(r=>setTimeout(r,100));
  const fallback=c.dataset.photoRenderer==='static'&&c.style.visibility!== 'hidden';
  stop();return {direct,fallback,layers:document.querySelectorAll('.dusk-photo-surface,.dusk-photo-fade').length};
 },photo);
 assert.deepEqual(photoResult,{direct:true,fallback:true,layers:0});
 console.log('PASS: direct GPU photo, context-loss fallback and layer cleanup');
}finally{await browser.close()}
