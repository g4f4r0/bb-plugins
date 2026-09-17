// Wallpaper changes dissolve over the same duration as the layer fade-in.
const FADE_MS = 240;
const sources = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
export function setSnapshotSource(canvas: HTMLCanvasElement, source: HTMLCanvasElement | null) {
  if (source) sources.set(canvas, source); else sources.delete(canvas);
}

export function snapshot(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  if (!canvas.hasAttribute("data-ready") || matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  canvas = sources.get(canvas) ?? canvas;
  const copy = document.createElement("canvas");
  copy.width = canvas.width; copy.height = canvas.height;
  copy.getContext("2d")?.drawImage(canvas, 0, 0);
  return copy;
}

export function drawFade(context: CanvasRenderingContext2D, from: HTMLCanvasElement, started: number, now = performance.now()) {
  const remaining = 1 - (now - started) / FADE_MS;
  if (remaining <= 0) return false;
  context.globalAlpha = remaining * remaining * (3 - 2 * remaining);
  // Image and ambient bitmaps can have different aspect ratios. Match the
  // wallpaper's centered cover crop throughout the dissolve.
  const scale = Math.max(context.canvas.width / from.width, context.canvas.height / from.height);
  const width = from.width * scale, height = from.height * scale;
  context.drawImage(from, (context.canvas.width - width) / 2, (context.canvas.height - height) / 2, width, height);
  context.globalAlpha = 1;
  return true;
}
