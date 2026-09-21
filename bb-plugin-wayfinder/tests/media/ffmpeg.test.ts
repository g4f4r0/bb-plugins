import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { optimizeImage } from "../../src/media/image.js";
import { runMediaProcess } from "../../src/media/process.js";
import { ClipRecorder, encodeClip, isFastStartMp4, probeVideo, selectH264Encoder } from "../../src/media/video.js";

// Real ffmpeg/ffprobe on this host; skipped (not faked) where they are absent.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

async function syntheticScreenshot(width: number, height: number): Promise<Buffer> {
  return runMediaProcess({
    executable: "ffmpeg",
    args: [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=1`,
      "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
    ],
    timeoutMs: 10_000,
    maxStdoutBytes: 16 * 1_048_576,
  });
}

describe.skipIf(!hasFfmpeg)("media encoding with real ffmpeg", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wayfinder-media-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps evidence lossless and picks the smaller measured format", async () => {
    const source = await syntheticScreenshot(1_280, 720);
    const result = await optimizeImage(source, { purpose: "evidence", maxWidth: 3_840, maxHeight: 2_160 });
    expect(["image/png", "image/webp"]).toContain(result.mimeType);
    expect(result.candidates).toHaveLength(2);
    expect(result.bytes.length).toBe(Math.min(...result.candidates.map((candidate) => candidate.sizeBytes)));
    expect({ width: result.width, height: result.height }).toEqual({ width: 1_280, height: 720 });
  });

  it("downscales thumbnails without upscaling or distorting aspect ratio", async () => {
    const source = await syntheticScreenshot(1_280, 720);
    const thumb = await optimizeImage(source, { purpose: "thumbnail", maxWidth: 320, maxHeight: 320 });
    expect(["image/webp", "image/jpeg"]).toContain(thumb.mimeType);
    expect(thumb.width).toBe(320);
    expect(thumb.height).toBe(180);
    expect(thumb.bytes.length).toBeLessThan(source.length);
    const small = await syntheticScreenshot(200, 100);
    const notUpscaled = await optimizeImage(small, { purpose: "thumbnail", maxWidth: 320, maxHeight: 320 });
    expect(notUpscaled.width).toBe(200);
  });

  it("encodes timestamped frames to fast-start H.264 yuv420p at 1280x720, preserving real timing", async () => {
    const { encoder, probed } = await selectH264Encoder();
    expect(probed.at(-1)).toEqual({ encoder, ok: true });
    const recorder = new ClipRecorder({ dir: path.join(dir, "frames"), maxFrames: 20, maxBytes: 32 * 1_048_576, maxDurationMs: 10_000 });
    const frame = await syntheticScreenshot(1_600, 900);
    const start = 1_000_000;
    // Irregular capture gaps: 0.2 s, 1 s, 0.3 s, then the final 0.5 s hold.
    for (const offset of [0, 200, 1_200, 1_500]) {
      expect(await recorder.append({ capturedAt: start + offset, bytes: frame, mimeType: "image/png" })).toBe(true);
    }
    expect(await recorder.append({ capturedAt: start + 1_400, bytes: frame, mimeType: "image/png" })).toBe(false);
    const output = path.join(dir, "clip.mp4");
    await encodeClip({ recorder, outputPath: output, encoder, maxBytes: 8 * 1_048_576 });
    const info = await probeVideo(output);
    expect(info).toMatchObject({ codec: "h264", pixelFormat: "yuv420p", width: 1_280, height: 720 });
    expect(info.durationMs).toBeGreaterThanOrEqual(1_900);
    expect(info.durationMs).toBeLessThanOrEqual(2_100);
    expect(await isFastStartMp4(output)).toBe(true);
    expect((await stat(output)).size).toBeLessThan(8 * 1_048_576);
    await recorder.dispose();
  }, 60_000);

  it("enforces the recorder's byte budget", async () => {
    const recorder = new ClipRecorder({ dir: path.join(dir, "budget"), maxFrames: 100, maxBytes: 10, maxDurationMs: 10_000 });
    expect(await recorder.append({ capturedAt: 1, bytes: new Uint8Array(11), mimeType: "image/png" })).toBe(false);
    expect(recorder.droppedFrames).toBe(1);
  });

  it("kills a process that exceeds its output cap", async () => {
    await expect(
      runMediaProcess({
        executable: "ffmpeg",
        args: ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "5", "-f", "rawvideo", "pipe:1"],
        timeoutMs: 10_000,
        maxStdoutBytes: 1_024,
      }),
    ).rejects.toMatchObject({ code: "output-too-large" });
  });
});
