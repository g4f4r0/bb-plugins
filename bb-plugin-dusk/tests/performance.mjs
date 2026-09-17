import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {chromium} from 'playwright';
const compile = async name => ts.transpileModule(await readFile(`lib/${name}.ts`, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const browser=await chromium.launch({executablePath:process.env.DUSK_BROWSER,headless:true,args:['--no-sandbox']});
try {
 const p=await browser.newPage();
 await p.setContent('<head><title>Initial</title></head><body><main><aside id="sidebar"></aside><article id="chat"></article></main></body>');
 await p.addScriptTag({content:(await compile('observe-roots')).replace('export function','function')+'\nwindow.changes=0;window.stopRoots=observeRoots("#sidebar",()=>window.changes++);'});
 await p.evaluate(()=>{for(let i=0;i<1000;i++)document.querySelector('#chat').append(document.createElement('div'));document.title='Streaming';});
 await p.waitForTimeout(80);
 assert.equal(await p.evaluate(()=>window.changes),0);
 await p.evaluate(()=>{document.querySelector('#sidebar').append(document.createElement('a'));});
 await p.waitForTimeout(80);
 assert.equal(await p.evaluate(()=>window.changes),1);
 await p.evaluate(()=>document.querySelector('#sidebar').outerHTML='<aside id="sidebar"></aside>');await p.waitForTimeout(80);
 await p.evaluate(()=>document.querySelector('#sidebar').append(document.createElement('a')));await p.waitForTimeout(80);
 assert.equal(await p.evaluate(()=>window.changes),3);
 await p.evaluate(()=>{window.stopRoots();document.querySelector('#sidebar').append(document.createElement('a'));});await p.waitForTimeout(80);
 assert.equal(await p.evaluate(()=>window.changes),3);
 console.log('PASS: 1,000 chat mutations ignored; sidebar replacement and cleanup.');
} finally {await browser.close();}
