import { it, expect } from "vitest";
import { liveFrameFromEvent } from "../src/cdp";
import { viewerHtml } from "../src/viewer";
import { browserIcons } from "../src/browser-icons";
import { ChevronDownIcon, CleanIcon, CookieIcon, OrientationPotraitToLandscapeIcon } from "@hugeicons/core-free-icons";

it("reads viewport size from a screencast event", () => {
  expect(
    liveFrameFromEvent(
      {
        data: "abc",
        metadata: { deviceWidth: 390.4, deviceHeight: 600.9 },
      },
      3,
    ),
  ).toEqual({ data: "abc", width: 390, height: 601, seq: 3 });
});
it("opens a same-origin screencast websocket from the viewer", () => {
  expect(viewerHtml).toContain("WebSocket");
  expect(viewerHtml).toContain("/cast");
  expect(viewerHtml).not.toContain("setTimeout(refresh,800)");
});
it("offers docked DevTools in the browser options", () => {
  expect(viewerHtml).toContain('data-maintenance="open-devtools"');
  expect(viewerHtml).toContain("Open DevTools");
  expect(viewerHtml).toContain('details[open]>summary');
  expect(viewerHtml).toContain('width:184px');
  expect(browserIcons.Cookie).toBe(CookieIcon);
  expect(browserIcons.Clean).toBe(CleanIcon);
});
it("offers a responsive-mode toolbar toggle and compact viewport controls", () => {
  expect(viewerHtml).toContain('id="responsive-toggle"');
  expect(viewerHtml).toContain('aria-pressed="false"');
  expect(viewerHtml).toContain('aria-pressed="false" disabled');
  expect(viewerHtml).toContain('.toolbar-group[aria-label="Page actions"]{width:92px}');
  expect(viewerHtml).toContain('id="responsive-controls"');
  expect(viewerHtml).toContain('iPhone 17 Pro Max');
  expect(viewerHtml).toContain("kind:'viewport'");
  expect(viewerHtml).toContain("responsiveToggle.onclick=()=>{if(!responsiveAvailable)");
  expect(viewerHtml).toContain("noteResponsiveQueued()");
  expect(viewerHtml).toContain("Taking control…");
  expect(viewerHtml).toContain("responsiveToggle.disabled=!responsiveAvailable;");
  expect(viewerHtml).not.toContain("responsiveToggle.disabled=!responsiveAvailable||!!responsivePending");
  expect(viewerHtml).toContain('data-pending="true"');
  expect(viewerHtml).toContain("requestResponsive(!responsiveEnabled");
  expect(viewerHtml).toContain("function openDevTools()");
  expect(viewerHtml).toContain("devtoolsSurface=true;expectedFrameWidth=1280;expectedFrameHeight=800;setResponsiveTransport(false)");
  expect(viewerHtml).not.toContain("requestResponsive(false,1280,800,false");
  expect(viewerHtml).not.toContain("Take control before changing the viewport.");
  expect(viewerHtml).toContain("responsivePending={enabled,width,height,mobile,preset}");
  expect(viewerHtml).toContain("prepareViewportFrame(devtoolsSurface?1280:width,devtoolsSurface?800:height)");
  expect(viewerHtml).toContain("videoAvailable&&(!enabled||devtoolsSurface)");
  expect(viewerHtml).toContain("function fallbackVideo(){metrics.transport='jpeg';videoMode=false;restartStream();}");
  expect(viewerHtml).not.toContain("videoAvailable=false");
  expect(viewerHtml).toContain("setTimeout(openCast,150)");
  expect(viewerHtml).toContain("if(responsivePending)return same(responsivePending)");
  expect(viewerHtml).toContain("responsivePreset=preset;renderResponsive();return true");
  expect(viewerHtml).toContain("responsiveAvailable=info.mode==='managed'");
  expect(viewerHtml).toContain("frameWidth=hasFrame&&!responsivePending?vw:expectedFrameWidth||");
  expect(viewerHtml).toContain("responsiveCommitSent");
  expect(viewerHtml).toContain("onControlQueueCleared");
  expect(viewerHtml).toContain("!expectedFrameWidth&&responsiveEnabled&&!devtoolsSurface");
  expect(viewerHtml).toContain("const completed=responsivePending");
  expect(viewerHtml).toContain("if(completed.enabled){responsiveWidth=completed.width");
  expect(viewerHtml).toContain("frame.width!==expectedFrameWidth");
  expect(viewerHtml).toContain("if(!screen.dataset.frame)");
  expect(viewerHtml).toContain("screen.removeAttribute('data-frame')");
  expect(viewerHtml).toContain("expectedFrameWidth=responsiveEnabled?responsiveWidth:1280");
  expect(viewerHtml).toContain("visible:inViewport&&!closed&&!paused&&!document.hidden");
  expect(viewerHtml).not.toContain("Date.now()-lastFrame<15000");
  expect(viewerHtml).toContain("background:var(--popover");
  expect(viewerHtml).not.toContain('id="fit-viewport"');
  expect(viewerHtml).not.toContain("fitMode");
  expect(browserIcons.Rotate).toBe(OrientationPotraitToLandscapeIcon);
  expect(browserIcons.ChevronDown).toBe(ChevronDownIcon);
});
it("uses the BB sidebar surface for the browser shell", () => {
  expect(viewerHtml).toContain("var(--sidebar,var(--background");
  expect(viewerHtml).toContain("sidebar-foreground");
  expect(viewerHtml).toContain("sidebar-border");
});

it("renders browser dialogs as interactive BB overlays", () => {
  expect(viewerHtml).toContain('id="dialog-overlay"');
  expect(viewerHtml).toContain('id="dialog-prompt"');
  expect(viewerHtml).toContain("kind:'dialog'");
  expect(viewerHtml).toContain("dialogMessage.textContent=dialog.message");
  expect(viewerHtml).toContain("const viewerInfoTimer=setInterval(refreshViewerInfo,1000)");
  expect(viewerHtml).toContain("You’re controlling");
  expect(viewerHtml).toContain("@media(max-width:520px){#status,#machine{display:none}}");
});

it('backs off capture without demand and permits a short active pipeline',async()=>{
  const {Cdp}=await import('../src/cdp');
  const c:any=Object.create(Cdp.prototype);
  c.casting=true;c.liveAcks=[];c.waiters=new Set();c.seq=0;c.send=async(...args:any[])=>{calls.push(args);return{};};
  const calls:any[]=[];
  c.onScreencast({sessionId:1,data:'frame',metadata:{deviceWidth:1280,deviceHeight:800}});
  expect(calls).toHaveLength(0);
  expect((await c.nextLiveFrame()).seq).toBe(1);
  expect(calls).toEqual([['Page.screencastFrameAck',{sessionId:1}]]);
  const next=c.nextLiveFrame(1);
  c.onScreencast({sessionId:2,data:'new',metadata:{deviceWidth:1280,deviceHeight:800}});
  expect((await next).seq).toBe(2);
  expect(calls.at(-1)).toEqual(['Page.screencastFrameAck',{sessionId:2}]);
  c.lastFrameDemand=Date.now()-100;
  c.onScreencast({sessionId:3,data:'waiting',metadata:{}});await c.stopLiveCast();
  expect(calls.slice(-2)).toEqual([['Page.screencastFrameAck',{sessionId:3}],['Page.stopScreencast']]);
});

it('acknowledges each captured frame even when Chrome repeats its session id',async()=>{
 const {Cdp}=await import('../src/cdp');const c:any=Object.create(Cdp.prototype);const calls:any[]=[];
 c.casting=true;c.liveAcks=[];c.waiters=new Set();c.seq=0;c.send=async(...args:any[])=>{calls.push(args);return{};};
 c.onScreencast({sessionId:7,data:'one',metadata:{}});c.onScreencast({sessionId:7,data:'two',metadata:{}});
 await c.nextLiveFrame();expect(calls).toEqual([['Page.screencastFrameAck',{sessionId:7}],['Page.screencastFrameAck',{sessionId:7}]]);
});

it('refreshes a static image when resuming after capture backpressure',async()=>{
 const {Cdp}=await import('../src/cdp');const c:any=Object.create(Cdp.prototype);const calls:any[]=[];
 c.casting=true;c.liveAcks=[1,1];c.waiters=new Set();c.seq=2;c.latest={data:'stale',seq:2};c.lastFrameDemand=Date.now()-1000;
 c.send=async(method:string,params:any)=>{calls.push(method);if(method==='Page.startScreencast')setTimeout(()=>c.onScreencast({sessionId:2,data:'fresh',metadata:{}}),0);return{};};
 const [one,two]=await Promise.all([c.nextLiveFrame(0),c.nextLiveFrame(0)]);
 expect(one.data).toBe('fresh');expect(two.data).toBe('fresh');
 expect(calls.filter(m=>m==='Page.startScreencast')).toHaveLength(1);
 expect(calls.filter(m=>m==='Page.stopScreencast')).toHaveLength(1);
});

it('refreshes an active static screencast after a viewport change',async()=>{
 const {Cdp}=await import('../src/cdp');const c:any=Object.create(Cdp.prototype);const calls:string[]=[];
 c.casting=true;c.liveAcks=[];c.waiters=new Set();c.seq=4;c.latest={data:'old',seq:4};c.streamTier=0;
 c.send=async(method:string)=>{calls.push(method);return{};};
 await c.refreshLiveCast();
 expect(calls).toEqual(['Page.stopScreencast','Page.startScreencast']);
 expect(c.latest).toBeUndefined();expect(c.casting).toBe(true);
});

it('serializes quality changes with concurrent frame requests without changing viewport',async()=>{
 const {Cdp}=await import('../src/cdp');const c:any=Object.create(Cdp.prototype);const calls:any[]=[];
 c.casting=true;c.streamTier=0;c.liveAcks=[];c.waiters=new Set();c.seq=0;c.lastFrameDemand=Date.now();
 c.send=async(method:string,params:any)=>{calls.push([method,params]);await new Promise(r=>setTimeout(r,1));if(method==='Page.startScreencast')setTimeout(()=>c.onScreencast({sessionId:1,data:'fresh',metadata:{deviceWidth:1280,deviceHeight:800}}),0);return{};};
 const results=await Promise.all([c.configureLiveCast(1),c.configureLiveCast(2),c.configureLiveCast(2),c.nextLiveFrame()]);
 expect(calls.filter(([m])=>m==='Page.startScreencast').map(([,p])=>p.quality)).toEqual([65,50]);
 expect(calls.some(([m])=>m==='Emulation.setDeviceMetricsOverride')).toBe(false);
 expect(results[3]).toMatchObject({width:1280,height:800});
});
