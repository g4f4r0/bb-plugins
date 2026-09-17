import { expect, it } from "vitest";
import { annotationContext, annotationLabel, captureClip, rectsExpression, targetExpression, type Annotation } from "../src/annotation";
import { browseAnnotationMessage } from "../src/annotation-message";
import { viewerHtml } from "../src/viewer";

const value: Annotation = {
  id: "a1",
  sessionId: "ab-1",
  threadId: "thr_1",
  hostId: "host_1",
  pageUrl: "https://example.com/",
  pageTitle: "Example Domain",
  comment: "Make this bigger",
  target: {
    tag: "h1",
    role: null,
    text: "Example Domain",
    selector: "body > div > h1",
    html: "<h1>Example Domain</h1>",
    styles: "font-size: 32px",
    rect: { x: 10.4, y: 20, width: 300, height: 40 },
  },
  anchor: { x: 0.5, y: 0.5 },
  screenshotPath: "/data/artifacts/ab-1/annotation-a1.png",
  createdAt: 1,
};

it("labels annotations by tag and shortened text", () => {
  expect(annotationLabel(value)).toBe("h1 · Example Domain");
  expect(annotationLabel({ target: { ...value.target, text: "x".repeat(40) } })).toBe(`h1 · ${"x".repeat(31)}…`);
  expect(annotationLabel({ target: { ...value.target, text: "" } })).toBe("h1");
});

it("renders agent context with the comment, element, and screenshot path", () => {
  const context = annotationContext(value);
  expect(context).toMatch(/^<browser_annotation id="a1">/);
  expect(context).toContain("Comment: Make this bigger");
  expect(context).toContain("Selector: body > div > h1");
  expect(context).toContain("Viewport rect: x=10 y=20 width=300 height=40");
  expect(context).toContain("/data/artifacts/ab-1/annotation-a1.png");
  expect(context).toContain("  <h1>Example Domain</h1>");
});

it("pads screenshot clips, keeps them inside the viewport, and offsets by scroll", () => {
  const viewport = { width: 400, height: 300, pageX: 0, pageY: 500 };
  expect(captureClip({ x: 2, y: 20, width: 100, height: 50 }, viewport)).toEqual({ x: 0, y: 512, width: 110, height: 66, scale: 1 });
  expect(captureClip({ x: 390, y: 290, width: 100, height: 100 }, viewport)).toEqual({ x: 382, y: 782, width: 18, height: 18, scale: 1 });
  expect(captureClip({ x: 900, y: 900, width: 10, height: 10 }, viewport)).toBeNull();
});

it("builds page expressions that only embed numbers and JSON selectors", () => {
  expect(targetExpression(12, 34)).toContain("elementFromPoint(12,34)");
  expect(rectsExpression(['a"b'])).toContain(JSON.stringify(['a"b']));
});

it("accepts only well-formed annotation messages from the viewer", () => {
  expect(browseAnnotationMessage({ type: "browse-annotation", annotation: { id: "a1", label: " h1 · Title " } })).toEqual({ id: "a1", label: "h1 · Title" });
  expect(browseAnnotationMessage({ type: "browse-annotation", annotation: { id: "a:1", label: "x" } })).toBeNull();
  expect(browseAnnotationMessage({ type: "other", annotation: { id: "a1", label: "x" } })).toBeNull();
  expect(browseAnnotationMessage(null)).toBeNull();
});

it("adds the annotate toggle, overlay, and comment bubble to the viewer", () => {
  expect(viewerHtml).toContain('id="annotate-toggle"');
  expect(viewerHtml).toContain('id="annotation-layer"');
  expect(viewerHtml).toContain('id="annotation-bubble"');
  expect(viewerHtml).toContain("parent.postMessage({type:'browse-annotation'");
  expect(viewerHtml).toContain("./annotation-transcribe");
});
