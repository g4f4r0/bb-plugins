import { z } from 'zod';
import type { Cdp } from './cdp';
const point = { x:z.number().min(0).max(50000), y:z.number().min(0).max(50000) };
export const directEvent = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('pointer'),type:z.enum(['down','up','move']),...point,button:z.enum(['left','middle','right','none']),buttons:z.number().int().min(0).max(7),clickCount:z.number().int().min(0).max(3).default(1),modifiers:z.number().int().min(0).max(15).default(0)}),
  z.object({kind:z.literal('wheel'),...point,deltaX:z.number().min(-3000).max(3000),deltaY:z.number().min(-3000).max(3000),modifiers:z.number().int().min(0).max(15).default(0)}),
  z.object({kind:z.literal('keyboard'),type:z.enum(['down','up']),key:z.string().min(1).max(40),code:z.string().max(40),modifiers:z.number().int().min(0).max(15),repeat:z.boolean().default(false)}),
  z.object({kind:z.literal('text'),text:z.string().max(10000)}),
  z.object({kind:z.literal('reset')}),
  z.object({kind:z.literal('heartbeat')}),
]);
export const directBatch = z.object({id:z.string().min(1).max(200),clientId:z.string().min(1).max(200),events:z.array(directEvent).min(1).max(64)});
export type DirectEvent = z.infer<typeof directEvent>;
const keyCodes:Record<string,number>={Backspace:8,Tab:9,Enter:13,Shift:16,Control:17,Alt:18,Escape:27,' ':32,PageUp:33,PageDown:34,End:35,Home:36,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Delete:46,Meta:91};
export const selectionExpression=`(()=>{let e=document.activeElement;while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement;if(e?.tagName==='INPUT'||e?.tagName==='TEXTAREA'){if(e.type==='password')return '';return typeof e.selectionStart==='number'?e.value.slice(e.selectionStart,e.selectionEnd).slice(0,100000):'';}return String(getSelection()||'').slice(0,100000)})()`;
/** One controller while keys/buttons are held. Disconnect/timeout always releases them. */
export class DirectInput {
  owner?:string;
  busy=false;
  private buttons=new Set<'left'|'middle'|'right'>();
  private keys=new Map<string,Record<string,unknown>>();
  private point={x:0,y:0};
  private timer?:ReturnType<typeof setTimeout>;
  constructor(
    private cdp:Pick<Cdp,'send'|'evaluate'>,
    private dialogOpen:()=>boolean=()=>false,
  ){}
  get held(){return this.buttons.size>0||this.keys.size>0;}
  async reset(clientId?:string){
    if(clientId&&this.owner&&this.owner!==clientId)return;
    clearTimeout(this.timer);
    for(const button of this.buttons)await this.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...this.point,button,buttons:0,clickCount:1}).catch(()=>{});
    for(const params of this.keys.values())await this.cdp.send('Input.dispatchKeyEvent',{...params,type:'keyUp',text:undefined,commands:undefined}).catch(()=>{});
    this.buttons.clear();this.keys.clear();this.owner=undefined;
  }
  async run(clientId:string,events:DirectEvent[]){
    if(this.busy||(this.owner&&this.owner!==clientId))throw Error('Browser is being controlled by another viewer.');
    clearTimeout(this.timer);this.busy=true;this.owner=clientId;let selection=false;let cursor:string|undefined;
    try{
      for(const e of events){
        if(e.kind==='reset'){await this.reset(clientId);continue;}
        if(e.kind==='pointer'){
          this.point={x:e.x,y:e.y};
          if(e.type==='down'&&e.button!=='none')this.buttons.add(e.button);
          await this.cdp.send('Input.dispatchMouseEvent',{type:e.type==='down'?'mousePressed':e.type==='up'?'mouseReleased':'mouseMoved',...this.point,button:e.button,buttons:e.buttons,clickCount:e.type==='move'?0:e.clickCount,modifiers:e.modifiers});
          if(e.type==='up'&&e.button!=='none'){this.buttons.delete(e.button);selection=true;}
        }else if(e.kind==='wheel')await this.cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:e.x,y:e.y,deltaX:e.deltaX,deltaY:e.deltaY,modifiers:e.modifiers});
        else if(e.kind==='text')await this.cdp.send('Input.insertText',{text:e.text});
        else if(e.kind==='keyboard'){
          const shortcut=!!(e.modifiers&6);const key=e.key.toLowerCase();
          const commands=shortcut?({a:['selectAll'],z:e.modifiers&8?['redo']:['undo'],y:['redo'],x:['deleteBackward']} as Record<string,string[]>)[key]:undefined;
          const text=!shortcut?(e.key==='Enter'?'\r':e.key.length===1?e.key:undefined):undefined;
          const params={key:e.key,code:e.code,modifiers:e.modifiers,windowsVirtualKeyCode:keyCodes[e.key]??(e.key.length===1?e.key.toUpperCase().charCodeAt(0):0)};
          if(e.type==='down')this.keys.set(e.code,params);
          await this.cdp.send('Input.dispatchKeyEvent',{...params,type:e.type==='up'?'keyUp':text!==undefined?'keyDown':'rawKeyDown',text:e.type==='down'?text:undefined,autoRepeat:e.repeat,commands:e.type==='down'?commands:undefined});
          if(e.type==='up'){this.keys.delete(e.code);selection=true;}
        }
      }
      const last=events.at(-1);
      if(!this.dialogOpen()&&last?.kind==='pointer')cursor=await this.cdp.evaluate(`(()=>{let e=document.elementFromPoint(${last.x},${last.y});while(e?.shadowRoot){const n=e.shadowRoot.elementFromPoint(${last.x},${last.y});if(!n||n===e)break;e=n;}return e?getComputedStyle(e).cursor:'default'})()`,250).catch(()=>undefined);
      return {selection:selection&&!this.dialogOpen()?await this.cdp.evaluate(selectionExpression,250).catch(()=>undefined):undefined,cursor};
    }catch(e){await this.reset(clientId);throw e;}
    finally{this.busy=false;clearTimeout(this.timer);if(this.held){this.timer=setTimeout(()=>void this.reset(clientId),5000);this.timer.unref();}else this.owner=undefined;}
  }
}
