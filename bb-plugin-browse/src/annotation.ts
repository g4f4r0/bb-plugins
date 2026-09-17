import { z } from "zod";
import { deepQuerySource } from "./observe";

const rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
});
export type AnnotationRect = z.infer<typeof rect>;

/** What the page reports about the element under the annotation pointer. */
export const annotationTarget = z.object({
  tag: z.string().max(100),
  role: z.string().max(100).nullable(),
  text: z.string().max(300),
  selector: z.string().max(2000),
  html: z.string().max(4000),
  styles: z.string().max(2000),
  rect,
});
export type AnnotationTarget = z.infer<typeof annotationTarget>;

export const annotation = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  sessionId: z.string(),
  threadId: z.string(),
  hostId: z.string(),
  pageUrl: z.string().max(4000),
  pageTitle: z.string().max(300),
  comment: z.string().max(4000),
  target: annotationTarget,
  /** Click position inside the element, as fractions of its box. */
  anchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).default({ x: 1, y: 0 }),
  screenshotPath: z.string().max(2000).nullable(),
  createdAt: z.number(),
});
export type Annotation = z.infer<typeof annotation>;

export const annotationPoint = z.object({
  x: z.number().min(0).max(50000),
  y: z.number().min(0).max(50000),
});
export const annotationSelectors = z.array(z.string().max(2000)).max(100);
export const annotationRectsOutput = z.array(rect.nullable());
export const annotationCaptureInput = z.object({ rect, name: z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/) });

/**
 * Page-side element lookup. Walks into open shadow roots so the reported
 * selector (with `>>>` hops) is replayable by `deepQuery`.
 */
export function targetExpression(x: number, y: number) {
  return `(()=>{
const clip=(value,limit)=>value.length>limit?value.slice(0,limit-1)+'…':value;
let element=document.elementFromPoint(${x},${y});
while(element&&element.shadowRoot){const inner=element.shadowRoot.elementFromPoint(${x},${y});if(!inner||inner===element)break;element=inner;}
if(!element||element===document.documentElement)return null;
const segment=node=>{if(node.id&&/^[A-Za-z][\\w-]*$/.test(node.id))return '#'+node.id;let part=node.localName;const parent=node.parentElement;if(parent){const same=[...parent.children].filter(child=>child.localName===node.localName);if(same.length>1)part+=':nth-of-type('+(same.indexOf(node)+1)+')';}return part;};
const hops=[];let node=element,parts=[];
while(node){parts.unshift(segment(node));if(node.id&&parts[0].startsWith('#'))break;const parent=node.parentElement;if(parent){node=parent;continue;}const root=node.getRootNode();if(root instanceof ShadowRoot){hops.unshift(parts.join(' > '));parts=[];node=root.host;continue;}break;}
hops.unshift(parts.join(' > '));
const box=element.getBoundingClientRect();
const style=getComputedStyle(element);
const styles=['display','position','width','height','margin','padding','color','background-color','font-family','font-size','font-weight','line-height','border','border-radius','gap'].map(name=>name+': '+style.getPropertyValue(name)).join('; ');
return {tag:element.localName,role:element.getAttribute('role'),text:clip((element.innerText||element.getAttribute('aria-label')||element.getAttribute('alt')||element.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim(),300),selector:clip(hops.filter(Boolean).join(' >>> '),2000),html:clip(element.outerHTML.replace(/\\s+/g,' '),4000),styles:clip(styles,2000),rect:{x:box.x,y:box.y,width:box.width,height:box.height}};
})()`;
}

/** Current viewport rects for saved annotation selectors, so markers follow scrolling. */
export function rectsExpression(selectors: string[]) {
  return `(()=>{${deepQuerySource}
return ${JSON.stringify(selectors)}.map(selector=>{try{const element=deepQuery(selector)[0];if(!element)return null;const box=element.getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height};}catch{return null;}});
})()`;
}

/** Screenshot clip for a viewport rect, padded and kept inside the viewport. */
export function captureClip(
  target: AnnotationRect,
  viewport: { width: number; height: number; pageX: number; pageY: number },
) {
  const pad = 8;
  const left = Math.max(0, target.x - pad);
  const top = Math.max(0, target.y - pad);
  const right = Math.min(viewport.width, target.x + target.width + pad);
  const bottom = Math.min(viewport.height, target.y + target.height + pad);
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    x: viewport.pageX + left,
    y: viewport.pageY + top,
    width: right - left,
    height: bottom - top,
    scale: 1,
  };
}

export function annotationLabel(value: Pick<Annotation, "target">) {
  const text = value.target.text.trim();
  const short = text.length > 32 ? `${text.slice(0, 31)}…` : text;
  return short ? `${value.target.tag} · ${short}` : value.target.tag;
}

function indent(value: string) {
  return value
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

/** Agent-visible context for one annotation, resolved when the message is sent. */
export function annotationContext(value: Annotation) {
  const lines = [
    `Page: ${value.pageUrl}`,
    ...(value.pageTitle ? [`Title: ${value.pageTitle}`] : []),
    `Browse session: ${value.sessionId}`,
    `Comment: ${value.comment || "(no comment)"}`,
    `Element: <${value.target.tag}>${value.target.role ? ` role=${value.target.role}` : ""}`,
    `Selector: ${value.target.selector}`,
    ...(value.target.text ? [`Text: ${value.target.text}`] : []),
    `Viewport rect: x=${Math.round(value.target.rect.x)} y=${Math.round(value.target.rect.y)} width=${Math.round(value.target.rect.width)} height=${Math.round(value.target.rect.height)}`,
    ...(value.screenshotPath
      ? [`Screenshot of the element (PNG on the Browse host): ${value.screenshotPath}`]
      : []),
    `HTML:\n${indent(value.target.html)}`,
    `Computed styles:\n${indent(value.target.styles)}`,
  ];
  return `<browser_annotation id="${value.id}">\n${lines.join("\n")}\n</browser_annotation>`;
}
