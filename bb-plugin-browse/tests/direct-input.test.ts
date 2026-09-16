import {it,expect,vi} from 'vitest';
import {DirectInput,directBatch,selectionExpression} from '../src/direct-input';
const pointer=(type:'down'|'move'|'up',buttons=0)=>({kind:'pointer' as const,type,x:20,y:30,button:'left' as const,buttons,clickCount:1,modifiers:0});
it('keeps drag ownership across batches and releases it on disconnect',async()=>{
 const cdp={send:vi.fn().mockResolvedValue({}),evaluate:vi.fn().mockResolvedValue('selected')};const input=new DirectInput(cdp);
 await input.run('a',[pointer('down',1)]);expect(input.held).toBe(true);
 await expect(input.run('b',[pointer('move')])).rejects.toThrow('another viewer');
 await input.run('a',[pointer('move',1)]);await input.reset('b');expect(input.held).toBe(true);
 await input.reset('a');expect(input.held).toBe(false);
 expect(cdp.send).toHaveBeenLastCalledWith('Input.dispatchMouseEvent',expect.objectContaining({type:'mouseReleased',button:'left',buttons:0}));
});
it('returns selection on pointer release and excludes password selections',async()=>{
 const cdp={send:vi.fn().mockResolvedValue({}),evaluate:vi.fn().mockImplementation(async e=>e===selectionExpression?'Selected text':'text')};const input=new DirectInput(cdp);
 await input.run('a',[pointer('down',1)]);expect(await input.run('a',[pointer('up')])).toEqual({selection:'Selected text',cursor:'text'});
 expect(selectionExpression).toContain("e.type==='password'");
});
it('does not block on cursor or selection inspection after a click opens a dialog',async()=>{
 let dialog=false;
 const cdp={
  send:vi.fn().mockImplementation(async()=>{dialog=true;}),
  evaluate:vi.fn(()=>new Promise(()=>{})),
 };
 const input=new DirectInput(cdp,()=>dialog);
 await expect(input.run('a',[pointer('down',1),pointer('up')])).resolves.toEqual({selection:undefined,cursor:undefined});
 expect(cdp.evaluate).not.toHaveBeenCalled();
 expect(input.busy).toBe(false);
});
it('dispatches editing keys directly and releases held keys after a failure',async()=>{
 const cdp={send:vi.fn().mockResolvedValue({}),evaluate:vi.fn().mockResolvedValue('')};const input=new DirectInput(cdp);
 await input.run('a',[{kind:'keyboard',type:'down',key:'a',code:'KeyA',modifiers:4,repeat:false}]);
 expect(cdp.send).toHaveBeenCalledWith('Input.dispatchKeyEvent',expect.objectContaining({commands:['selectAll'],type:'rawKeyDown'}));
 cdp.send.mockRejectedValueOnce(Error('lost'));
 await expect(input.run('a',[{kind:'text',text:'example'}])).rejects.toThrow('lost');expect(input.held).toBe(false);
 expect(cdp.send).toHaveBeenLastCalledWith('Input.dispatchKeyEvent',expect.objectContaining({type:'keyUp',key:'a'}));
});
it('bounds messages and rejects arbitrary protocol commands',()=>{
 expect(()=>directBatch.parse({id:'session',clientId:'client',events:Array(65).fill(pointer('move'))})).toThrow();
 expect(()=>directBatch.parse({id:'session',clientId:'client',events:[{kind:'cdp',method:'Browser.close'}]})).toThrow();
});
it('sends Enter as a text-producing key and keeps ordinary DOM key events',async()=>{
 const cdp={send:vi.fn().mockResolvedValue({}),evaluate:vi.fn().mockResolvedValue('')};const input=new DirectInput(cdp);
 for(const [key,code,text] of [['Enter','Enter','\r'],['a','KeyA','a']]){
  await input.run('a',[{kind:'keyboard',type:'down',key,code,modifiers:0,repeat:false},{kind:'keyboard',type:'up',key,code,modifiers:0,repeat:false}]);
  expect(cdp.send).toHaveBeenCalledWith('Input.dispatchKeyEvent',expect.objectContaining({type:'keyDown',key,text}));
 }
 expect(input.held).toBe(false);
});
it('maintains held input with heartbeats, then releases it after a lost client',async()=>{
 vi.useFakeTimers();
 try{
  const cdp={send:vi.fn().mockResolvedValue({}),evaluate:vi.fn().mockResolvedValue('')};const input=new DirectInput(cdp);
  await input.run('a',[pointer('down',1)]);
  await vi.advanceTimersByTimeAsync(4000);await input.run('a',[{kind:'heartbeat'}]);
  await vi.advanceTimersByTimeAsync(4000);expect(input.held).toBe(true);
  await vi.advanceTimersByTimeAsync(1001);expect(input.held).toBe(false);
  expect(cdp.send).toHaveBeenLastCalledWith('Input.dispatchMouseEvent',expect.objectContaining({type:'mouseReleased'}));
 }finally{vi.useRealTimers();}
});
