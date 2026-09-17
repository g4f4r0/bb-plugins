// Adapted from Aura's capy-effect.ts (MIT). See THIRD_PARTY_NOTICES.md.
import { VERTEX_SHADER, ANIMATED_PHOTO_SHADER } from "./photo-shaders";
import { setSnapshotSource } from "./fade";

/** Present Aura's photo texture directly; the 2D canvas retains handoff frames. */
export function animatePhoto(canvas: HTMLCanvasElement, image: HTMLImageElement, from: HTMLCanvasElement | null): () => void {
  const surface = document.createElement("canvas");
  const gl = surface.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const visible = canvas.getContext("2d")!;
  let disposed = false, lost = false, inView = true, raf = 0;
  let previous = 0, lastDraw = 0, time = 40;
  const previousVisibility = canvas.style.visibility;
  let fade: Animation | null = null;
  const clearFade = () => { if (fade) { fade.onfinish = null; fade.cancel(); fade = null; } from?.remove(); };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, texture: WebGLTexture | null = null;
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const uniform = (name: string) => {
    if (!uniforms.has(name)) uniforms.set(name, gl!.getUniformLocation(program!, name));
    return uniforms.get(name)!;
  };

  function releaseGl() {
    if (!gl) return;
    if (texture) gl.deleteTexture(texture);
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach(shader => gl.deleteShader(shader));
    texture = null; buffer = null; program = null; shaders.length = 0;
  }

  function fallback() {
    clearFade(); surface.remove(); setSnapshotSource(canvas, null); canvas.style.visibility = previousVisibility;
    // Like Aura, retain the original photo if WebGL is unavailable or lost.
    const scale = Math.min(1, 2400 / image.naturalWidth, 1800 / image.naturalHeight);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    visible.drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.dataset.ready = "";
    canvas.dataset.photoRenderer = "static";
  }

  try {
    if (!gl) throw new Error("WebGL unavailable");
    program = gl.createProgram(); buffer = gl.createBuffer(); texture = gl.createTexture();
    if (!program || !buffer || !texture) throw new Error("WebGL allocation failed");
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, ANIMATED_PHOTO_SHADER]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Shader allocation failed");
      shaders.push(shader);
      const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
      gl.shaderSource(shader, precision && precision.precision < 23 ? source.replace(/precision mediump float/g, "precision highp float") : source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Photo shader compilation failed");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Photo shader link failed");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    for (const [key, value] of Object.entries({ u_originX: .5, u_originY: .5, u_worldWidth: 0, u_worldHeight: 0, u_fit: 2, u_scale: 1, u_rotation: 0, u_offsetX: 0, u_offsetY: 0, u_type: 4, u_pxSize: 2, u_colorSteps: 4 })) gl.uniform1f(uniform(key), value);
    gl.uniform1i(uniform("u_originalColors"), 1);
    gl.uniform1i(uniform("u_inverted"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.uniform1i(uniform("u_image"), 0);
    gl.uniform1f(uniform("u_imageAspectRatio"), image.naturalWidth / image.naturalHeight);
  } catch {
    releaseGl(); gl?.getExtension("WEBGL_lose_context")?.loseContext();
    fallback();
    return () => { delete canvas.dataset.photoRenderer; };
  }

  surface.className = "dusk-photo-surface";
  canvas.before(surface);
  setSnapshotSource(canvas, surface);
  if (from && !reduced.matches) {
    from.className = "dusk-photo-fade";
    canvas.before(from);
    fade = from.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: "ease-in-out", fill: "forwards" });
    fade.onfinish = clearFade;
  }

  function draw() {
    if (disposed || lost) return;
    gl!.useProgram(program);
    gl!.uniform1f(uniform("u_time"), time);
    gl!.clear(gl!.COLOR_BUFFER_BIT); gl!.drawArrays(gl!.TRIANGLES, 0, 6);
    // Present the GPU surface directly. Read back only at a renderer handoff.
    surface.dataset.ready = "";
    canvas.style.visibility = "hidden";
    canvas.dataset.ready = "";
    canvas.dataset.photoRenderer = "webgl";
  }

  function resize() {
    if (disposed || lost) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const scale = Math.min(.5, Math.sqrt(2073600 / (width * height)));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (surface.width !== w) surface.width = w;
    if (surface.height !== h) surface.height = h;
    gl!.viewport(0, 0, w, h);
    gl!.useProgram(program);
    gl!.uniform2f(uniform("u_resolution"), w, h);
    gl!.uniform1f(uniform("u_pixelRatio"), w / width);
    // Redraw in the ResizeObserver delivery, before paint. Retain the source
    // texture throughout the sidebar transition; no delayed recrop or decode.
    draw();
  }

  function tick(now: number) {
    raf = 0;
    if (disposed || lost || document.hidden || !inView || reduced.matches) return;
    if (previous) time += Math.min(now - previous, 1000 / 15) * .0005;
    previous = now;
    if (now - lastDraw >= 1000 / 30) { draw(); lastDraw = now; }
    raf = requestAnimationFrame(tick);
  }
  function schedule() {
    cancelAnimationFrame(raf); raf = 0; previous = 0;
    if (disposed || lost || document.hidden || !inView) return;
    if (reduced.matches) clearFade();
    draw();
    if (!reduced.matches) raf = requestAnimationFrame(tick);
  }
  function onLost(event: Event) {
    event.preventDefault(); lost = true;
    cancelAnimationFrame(raf); raf = 0;
    fallback();
  }
  surface.addEventListener("webglcontextlost", onLost);
  const observer = new ResizeObserver(resize); observer.observe(canvas);
  const intersection = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; schedule(); }); intersection.observe(canvas);
  document.addEventListener("visibilitychange", schedule); reduced.addEventListener("change", schedule);
  resize(); schedule();
  return () => {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(raf);
    // Keep the last photo visible while a replacement image is decoding.
    if (!lost && surface.width && surface.height) {
      canvas.width = surface.width; canvas.height = surface.height;
      visible.drawImage(surface, 0, 0);
    }
    clearFade(); surface.remove(); setSnapshotSource(canvas, null);
    canvas.style.visibility = previousVisibility;
    observer.disconnect(); intersection.disconnect();
    document.removeEventListener("visibilitychange", schedule); reduced.removeEventListener("change", schedule);
    surface.removeEventListener("webglcontextlost", onLost);
    releaseGl(); gl!.getExtension("WEBGL_lose_context")?.loseContext();
    delete canvas.dataset.photoRenderer;
  };
}
