import { drawFade } from "./fade";

// Preserve motion phase across viewport and theme repaints.
let ambientTime = 0;

/** A slowly moving field rendered through a stationary ordered-dither matrix. */
export function animateAmbient(canvas: HTMLCanvasElement, base: readonly number[], dark: boolean, from: HTMLCanvasElement | null = null): () => void {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--primary").trim() || getComputedStyle(canvas).color;
  ctx.fillRect(0, 0, 1, 1);
  const primary = Array.from(ctx.getImageData(0, 0, 1, 1).data);
  const ground = base.map((value, i) => i < 3 && dark ? 0 : value);
  const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const pixels = ctx.createImageData(w, h);
  const fieldW = 80, fieldH = 60;
  const field = new Float32Array((fieldW + 1) * (fieldH + 1));
  // Pack colors once; the hot loop writes one pixel rather than four channels.
  // The typed views share native byte order, including on big-endian machines.
  const colors = new Uint8ClampedArray(1025 * 4);
  for (let i = 0; i <= 1024; i++) {
    for (let c = 0; c < 3; c++) colors[i * 4 + c] = ground[c] + (primary[c] - ground[c]) * (i === 1024 ? 0.29 : i / 1023 * 0.035);
    colors[i * 4 + 3] = 255;
  }
  const palette = new Uint32Array(colors.buffer);
  const output = new Uint32Array(pixels.data.buffer);
  const columns = new Uint16Array(w), weights = new Float32Array(w);
  for (let x = 0; x < w; x++) { const fx = x / w * fieldW; columns[x] = Math.floor(fx); weights[x] = fx - columns[x]; }
  const row = new Float32Array(fieldW + 1);
  let frame = 0, last = 0, time = ambientTime, visible = true, disposed = false, fading = !!from;
  const fadeStart = performance.now();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  function paint() {
    // Evaluate the smooth field on a small grid, then interpolate at pixel size.
    for (let y = 0; y <= fieldH; y++) for (let x = 0; x <= fieldW; x++) {
      const nx = x / fieldW, ny = y / fieldH;
      const wave = 0.48 + 0.28 * Math.sin(nx * 8 + Math.sin(ny * 6 + time * 0.18) + time * 0.13)
        + 0.18 * Math.cos(nx * 12 - ny * 7 - time * 0.16);
      const quietCenter = Math.exp(-((nx - 0.5) ** 2 * 14 + (ny - 0.47) ** 2 * 18));
      const fade = Math.max(0, 1 - ny * 1.42) ** 1.2;
      field[y * (fieldW + 1) + x] = Math.max(0, Math.min(0.9, wave * fade * (1 - quietCenter * 0.87)));
    }
    for (let y = 0; y < h; y++) {
      const fy = y / h * fieldH, iy = Math.floor(fy), ty = fy - iy;
      const a = iy * (fieldW + 1), b = a + fieldW + 1;
      for (let x = 0; x <= fieldW; x++) row[x] = field[a + x] * (1 - ty) + field[b + x] * ty;
      const matrixRow = (y & 3) * 4, offset = y * w;
      for (let x = 0; x < w; x++) {
        const ix = columns[x], tx = weights[x];
        const density = row[ix] * (1 - tx) + row[ix + 1] * tx;
        output[offset + x] = palette[density > (matrix[matrixRow + (x & 3)] + 0.5) / 16 ? 1024 : Math.round(density * 1023)];
      }
    }
    ctx.putImageData(pixels, 0, 0);
    if (fading) fading = drawFade(ctx, from!, fadeStart);
  }
  function tick(now: number) {
    frame = 0;
    if (disposed || document.hidden || !visible || reducedMotion.matches) return;
    if (!last || now - last >= 50 || fading) {
      time += last ? Math.min(100, now - last) / 1000 : 0;
      ambientTime = time;
      last = now; paint();
    }
    frame = requestAnimationFrame(tick);
  }
  function reconcile() {
    cancelAnimationFrame(frame); frame = 0; last = 0;
    if (disposed) return;
    if (reducedMotion.matches && fading) { fading = false; paint(); }
    if (!document.hidden && visible && !reducedMotion.matches) frame = requestAnimationFrame(tick);
  }
  const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; reconcile(); });
  intersection.observe(canvas);
  document.addEventListener("visibilitychange", reconcile);
  reducedMotion.addEventListener("change", reconcile);
  paint(); reconcile();
  return () => {
    disposed = true; cancelAnimationFrame(frame); intersection.disconnect();
    document.removeEventListener("visibilitychange", reconcile);
    reducedMotion.removeEventListener("change", reconcile);
  };
}
