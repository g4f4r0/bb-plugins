import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import { useStatusList } from './status-list-preference.mjs';
const browser=await chromium.launch({executablePath:process.env.DUSK_BROWSER,args:['--no-sandbox']});
try {
 const p=await browser.newPage();await useStatusList(p);await p.goto(process.env.BB_TEST_URL||'http://127.0.0.1:38886');await p.locator('.dusk-status-link').first().waitFor();
 const ids=await p.locator('.dusk-status-link').evaluateAll(nodes=>nodes.slice(0,4).map(n=>n.dataset.sidebarThreadId));
 assert(ids.length>=3,'Need three existing visible threads for read-only portal fixture');
 const cdp=await p.context().newCDPSession(p);const events=[];cdp.on('Tracing.dataCollected',e=>events.push(...e.value));await cdp.send('Tracing.start',{categories:'devtools.timeline,v8.execute',transferMode:'ReportEvents'});
 await p.evaluate(ids=>{
  const fixture=document.createElement('div');fixture.id='dusk-native-fixture';document.querySelector('[data-sidebar="sidebar"]').append(fixture);
  for(const id of ids){const row=document.createElement('div');row.innerHTML=`<a data-sidebar-thread-id="${id}"></a><span class="bb-thread-title"><span class="truncate">Fixture</span></span><span data-sidebar-row-controls><button></button></span>`;fixture.append(row)}
 },ids);
 await p.locator('#dusk-native-fixture .dusk-pin-slot button').nth(1).waitFor();
 await p.evaluate(()=>{window.retainedPin=document.querySelector('#dusk-native-fixture').children[1].querySelector('.dusk-pin-slot button');document.querySelector('#dusk-native-fixture').firstElementChild.remove()});
 await p.waitForTimeout(200);
 const retained=await p.evaluate(()=>window.retainedPin===document.querySelector('#dusk-native-fixture').firstElementChild.querySelector('.dusk-pin-slot button'));
 const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');await done;
 const dir=new URL('../validation/artifacts/',import.meta.url);await mkdir(dir,{recursive:true});await writeFile(new URL(`${process.env.DUSK_LABEL||'portals'}.trace.json`,dir),JSON.stringify({traceEvents:events}));
 console.log(JSON.stringify({retainedPinIdentity:retained}));if(process.env.DUSK_EXPECT_FIXED)assert(retained);
}finally{await browser.close()}
