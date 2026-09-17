import {viewerTrace} from '../src/viewer-trace';
import {it,expect,vi} from 'vitest';import {JSDOM} from 'jsdom';import {viewerHtml} from '../src/viewer';
it('keeps the current frame ratio until the requested viewport frame arrives',()=>{
 const dom=new JSDOM('<main id="viewport" style="padding:12px"><div id="viewport-skeleton"></div><div id="browser-surface"><canvas id="screen" data-frame="true"></canvas></div></main>',{runScripts:'outside-only',pretendToBeVisual:true});
 Object.defineProperties(dom.window.document.querySelector('#viewport'),{clientWidth:{value:1400},clientHeight:{value:1000}});
 (dom.window as any).ResizeObserver=class{observe(){}};
 const code=viewerHtml.slice(viewerHtml.indexOf('const viewport='),viewerHtml.indexOf('const metrics=window.browseMetrics'));
  dom.window.eval(`const screen=document.querySelector('#screen');let vw=1280,vh=800,responsiveEnabled=false,responsiveWidth=412,responsiveHeight=915,responsivePending=null,expectedFrameWidth=0,expectedFrameHeight=0;${code};window.fitViewer=fit;window.stageFrame=(w,h)=>{responsivePending={enabled:true,width:w,height:h,mobile:true,preset:'custom'};expectedFrameWidth=w;expectedFrameHeight=h;fit();};window.commitFrame=(w,h)=>{vw=w;vh=h;responsivePending=null;expectedFrameWidth=0;expectedFrameHeight=0;fit();};`);
  try{
   (dom.window as any).fitViewer();
   const surface=dom.window.document.querySelector('#browser-surface') as HTMLElement;
   expect(surface.style.width).toBe('1280px');
   expect(surface.style.height).toBe('800px');
   (dom.window as any).stageFrame(412,915);
   expect(surface.style.width).toBe('412px');
   expect(surface.style.height).toBe('915px');
   (dom.window as any).commitFrame(412,915);
   expect(surface.style.width).toBe('412px');
   expect(surface.style.height).toBe('915px');
  }finally{dom.window.close();}
});
it('paints the freshest decoded frame and closes every replaced bitmap',async()=>{
 const dom=new JSDOM('<div id="viewport"></div><div id="viewport-skeleton"></div><canvas id="screen"></canvas><span id="resolution"></span>',{runScripts:'outside-only',pretendToBeVisual:true});
 const callbacks:Array<()=>void>=[],draw=vi.fn(),bitmaps=[1,2,3].map(n=>({width:1280,height:800,n,close:vi.fn()}));
 const wide={width:1280,height:800,n:4,close:vi.fn()},mobile={width:412,height:915,n:5,close:vi.fn()},staleMobile={width:412,height:915,n:6,close:vi.fn()},desktop={width:1280,height:800,n:7,close:vi.fn()};
 const acks=[vi.fn(),vi.fn(),vi.fn(),vi.fn(),vi.fn(),vi.fn(),vi.fn()];let finishFirst:(v:unknown)=>void=()=>{};
 const first=new Promise(r=>finishFirst=r);
 (dom.window as any).createImageBitmap=vi.fn().mockImplementationOnce(()=>first).mockResolvedValueOnce(bitmaps[2]).mockResolvedValueOnce(wide).mockResolvedValueOnce(mobile).mockResolvedValueOnce(staleMobile).mockResolvedValueOnce(desktop);
 dom.window.requestAnimationFrame=(cb:any)=>{callbacks.push(cb);return callbacks.length;};
 (dom.window.document.querySelector('canvas') as any).getContext=()=>({drawImage:draw});
 const code=viewerHtml.slice(viewerHtml.indexOf('let statusErrorUntil=0,'),viewerHtml.indexOf('function show(frame)'));
 dom.window.eval(`${viewerTrace}const screen=document.querySelector('canvas'),metrics={bytes:0,dropped:0,displayed:0},status={textContent:''},address={value:''};let closed=false,inViewport=true,vw=1280,vh=800,lastFrame=0,seq=0,pageLoading=false,currentUrl='',acting=false,responsiveEnabled=false,responsiveWidth=412,responsiveHeight=915,responsiveMobile=true,responsivePreset='responsive',responsivePending=null,expectedFrameWidth=0,expectedFrameHeight=0;function fit(){}function renderCopy(){}function renderResponsive(){}function setResponsiveTransport(){};${code};window.accept=acceptFrame;window.metrics=metrics;window.startMobile=()=>{responsivePending={enabled:true,width:412,height:915,mobile:true,preset:'responsive'};expectedFrameWidth=412;expectedFrameHeight=915;};window.startDesktop=()=>{responsivePending={enabled:false,width:1280,height:800,mobile:false,preset:'responsive'};expectedFrameWidth=1280;expectedFrameHeight=800;};window.responsiveState=()=>({enabled:responsiveEnabled,pending:!!responsivePending,width:responsiveWidth,height:responsiveHeight});`);
 try{
  const accept=(dom.window as any).accept;
  accept({size:1},{seq:1,width:1280,height:800},acks[0]);
  accept({size:1},{seq:2,width:1280,height:800},acks[1]);
  accept({size:1},{seq:3,width:1280,height:800},acks[2]);
  expect(acks[1]).toHaveBeenCalledOnce();
  finishFirst(bitmaps[0]);await new Promise(r=>setTimeout(r,0));
  expect(bitmaps[0].close).toHaveBeenCalledOnce();expect(callbacks).toHaveLength(1);
  expect((dom.window.document.querySelector("#viewport-skeleton") as HTMLElement).hidden).toBe(false);
  callbacks[0]();expect((dom.window.document.querySelector("#viewport-skeleton") as HTMLElement).hidden).toBe(true);expect(draw).toHaveBeenCalledWith(bitmaps[2],0,0,1280,800);
  expect(bitmaps[2].close).toHaveBeenCalledOnce();for(const ack of acks.slice(0,3))expect(ack).toHaveBeenCalledOnce();
  expect((dom.window as any).metrics).toMatchObject({displayed:1,dropped:2});
  (dom.window as any).startMobile();
  expect((dom.window as any).responsiveState()).toEqual({enabled:false,pending:true,width:412,height:915});
  accept({size:1},{seq:4,width:1280,height:800},acks[3]);await new Promise(r=>setTimeout(r,0));callbacks.shift()?.();
  expect(draw).toHaveBeenCalledTimes(1);expect(wide.close).toHaveBeenCalledOnce();expect(acks[3]).toHaveBeenCalledOnce();
  expect((dom.window as any).responsiveState()).toEqual({enabled:false,pending:true,width:412,height:915});
  accept({size:1},{seq:5,width:412,height:915},acks[4]);await new Promise(r=>setTimeout(r,0));callbacks.shift()?.();
  expect(draw).toHaveBeenLastCalledWith(mobile,0,0,412,915);expect(mobile.close).toHaveBeenCalledOnce();expect(acks[4]).toHaveBeenCalledOnce();
  expect((dom.window as any).responsiveState()).toEqual({enabled:true,pending:false,width:412,height:915});
  (dom.window as any).startDesktop();
  accept({size:1},{seq:6,width:412,height:915},acks[5]);await new Promise(r=>setTimeout(r,0));callbacks.shift()?.();
  expect(draw).toHaveBeenCalledTimes(2);expect(staleMobile.close).toHaveBeenCalledOnce();expect(acks[5]).toHaveBeenCalledOnce();
  expect((dom.window as any).responsiveState()).toEqual({enabled:true,pending:true,width:412,height:915});
  accept({size:1},{seq:7,width:1280,height:800},acks[6]);await new Promise(r=>setTimeout(r,0));callbacks.shift()?.();
  expect(draw).toHaveBeenLastCalledWith(desktop,0,0,1280,800);expect(desktop.close).toHaveBeenCalledOnce();expect(acks[6]).toHaveBeenCalledOnce();
  expect((dom.window as any).responsiveState()).toEqual({enabled:false,pending:false,width:412,height:915});
 }finally{dom.window.close();}
});
