import { existsSync } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runMediaProcess } from "./process.js";

export type H264Encoder = "libx264" | "h264_nvenc" | "h264_vaapi";

const VAAPI_DEVICE = "/dev/dri/renderD128";

function encoderArgs(encoder: H264Encoder): { pre: string[]; codec: string[]; filterSuffix: string } {
  switch (encoder) {
    case "h264_vaapi":
      return { pre: ["-vaapi_device", VAAPI_DEVICE], codec: ["-c:v", "h264_vaapi", "-qp", "24"], filterSuffix: ",format=nv12,hwupload" };
    case "h264_nvenc":
      return { pre: [], codec: ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "24", "-pix_fmt", "yuv420p"], filterSuffix: "" };
    case "libx264":
      return { pre: [], codec: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"], filterSuffix: "" };
  }
}

/**
 * Selects a hardware H.264 encoder only if it actually encodes a test clip on
 * this host; an encoder merely listed by `ffmpeg -encoders` is not trusted.
 * Falls back to bounded libx264.
 */
export async function selectH264Encoder(options: { ffmpegPath?: string; signal?: AbortSignal } = {}): Promise<{
  encoder: H264Encoder;
  probed: readonly { encoder: H264Encoder; ok: boolean }[];
}> {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const probed: { encoder: H264Encoder; ok: boolean }[] = [];
  const order: H264Encoder[] = existsSync(VAAPI_DEVICE) ? ["h264_vaapi", "h264_nvenc", "libx264"] : ["h264_nvenc", "libx264"];
  for (const encoder of order) {
    const args = encoderArgs(encoder);
    try {
      await runMediaProcess({
        executable: ffmpeg,
        args: [
          "-hide_banner", "-loglevel", "error", ...args.pre,
          "-f", "lavfi", "-i", "testsrc2=size=256x144:rate=5", "-frames:v", "3",
          "-vf", `format=yuv420p${args.filterSuffix}`, ...args.codec, "-f", "null", "-",
        ],
        timeoutMs: 10_000,
        maxStdoutBytes: 65_536,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      probed.push({ encoder, ok: true });
      return { encoder, probed };
    } catch {
      probed.push({ encoder, ok: false });
    }
  }
  throw new Error("No functional H.264 encoder");
}

export interface RecordedFrame {
  readonly capturedAt: number;
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

/**
 * Bounded frame journal for clips. Frames are written under generated names
 * with their original capture timestamps; the encoder uses those timestamps,
 * so the MP4 preserves real timing. Frames past the byte/count/duration limits
 * are dropped and counted, never buffered in memory.
 */
export class ClipRecorder {
  readonly #dir: string;
  readonly #maxFrames: number;
  readonly #maxBytes: number;
  readonly #maxDurationMs: number;
  readonly #frames: { file: string; capturedAt: number }[] = [];
  #bytes = 0;
  #dropped = 0;

  constructor(options: { dir: string; maxFrames: number; maxBytes: number; maxDurationMs: number }) {
    if (!path.isAbsolute(options.dir)) throw new Error("Clip directory must be absolute");
    this.#dir = options.dir;
    this.#maxFrames = options.maxFrames;
    this.#maxBytes = options.maxBytes;
    this.#maxDurationMs = options.maxDurationMs;
  }

  get frameCount(): number {
    return this.#frames.length;
  }

  get droppedFrames(): number {
    return this.#dropped;
  }

  async append(frame: RecordedFrame): Promise<boolean> {
    const first = this.#frames[0]?.capturedAt;
    const last = this.#frames.at(-1)?.capturedAt;
    if (
      this.#frames.length >= this.#maxFrames ||
      this.#bytes + frame.bytes.length > this.#maxBytes ||
      (first !== undefined && frame.capturedAt - first > this.#maxDurationMs) ||
      (last !== undefined && frame.capturedAt <= last)
    ) {
      this.#dropped += 1;
      return false;
    }
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const extension = frame.mimeType === "image/png" ? "png" : frame.mimeType === "image/jpeg" ? "jpg" : "webp";
    const file = `f${String(this.#frames.length).padStart(6, "0")}.${extension}`;
    await writeFile(path.join(this.#dir, file), frame.bytes, { flag: "wx", mode: 0o600 });
    this.#frames.push({ file, capturedAt: frame.capturedAt });
    this.#bytes += frame.bytes.length;
    return true;
  }

  /** Concat-demuxer script with per-frame durations from real timestamps. */
  concatScript(finalFrameMs = 500): string {
    const lines = ["ffconcat version 1.0"];
    this.#frames.forEach((frame, index) => {
      const next = this.#frames[index + 1];
      const durationMs = next === undefined ? finalFrameMs : next.capturedAt - frame.capturedAt;
      lines.push(`file '${frame.file}'`, `duration ${(durationMs / 1_000).toFixed(3)}`);
    });
    // The concat demuxer ignores the last duration unless the file repeats.
    const last = this.#frames.at(-1);
    if (last !== undefined) lines.push(`file '${last.file}'`);
    return `${lines.join("\n")}\n`;
  }

  /** Writes the script beside the frames; the concat demuxer resolves names relative to it. */
  async writeConcatScript(): Promise<string> {
    const script = path.join(this.#dir, "frames.ffconcat");
    await writeFile(script, this.concatScript(), { mode: 0o600 });
    return script;
  }

  timeline(): { startedAt: number | null; endedAt: number | null } {
    return { startedAt: this.#frames[0]?.capturedAt ?? null, endedAt: this.#frames.at(-1)?.capturedAt ?? null };
  }

  async dispose(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
  }
}

export interface EncodeClipOptions {
  readonly recorder: ClipRecorder;
  readonly outputPath: string;
  readonly encoder: H264Encoder;
  readonly maxBytes: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Encodes recorded frames to a fast-start H.264/yuv420p MP4, fit inside
 * 1280x720 by default with even dimensions and preserved aspect ratio.
 */
export async function encodeClip(options: EncodeClipOptions): Promise<void> {
  if (options.recorder.frameCount === 0) throw new Error("No frames recorded");
  const width = options.maxWidth ?? 1_280;
  const height = options.maxHeight ?? 720;
  const script = await options.recorder.writeConcatScript();
  const args = encoderArgs(options.encoder);
  const filter =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p${args.filterSuffix}`;
  await runMediaProcess({
    executable: options.ffmpegPath ?? "ffmpeg",
    args: [
      "-hide_banner", "-loglevel", "error", "-y", ...args.pre,
      "-f", "concat", "-safe", "1", "-i", script,
      "-vf", filter, "-fps_mode", "vfr", ...args.codec,
      "-movflags", "+faststart", "-fs", String(options.maxBytes), "-an", options.outputPath,
    ],
    timeoutMs: options.timeoutMs ?? 120_000,
    maxStdoutBytes: 65_536,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!(await isFastStartMp4(options.outputPath))) throw new Error("Encoded clip is not fast-start MP4");
}

/** True when the `moov` box precedes `mdat`, so playback can start before download ends. */
export async function isFastStartMp4(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    let offset = 0;
    const header = Buffer.alloc(16);
    for (let boxes = 0; boxes < 64 && offset + 8 <= size; boxes += 1) {
      await handle.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      if (boxSize < 8) return false;
      offset += boxSize;
    }
    return false;
  } finally {
    await handle.close();
  }
}

export async function probeVideo(file: string, ffprobePath = "ffprobe") {
  const output = await runMediaProcess({
    executable: ffprobePath,
    args: [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt,width,height:format=duration",
      "-of", "json", file,
    ],
    timeoutMs: 10_000,
    maxStdoutBytes: 65_536,
  });
  const parsed = JSON.parse(output.toString("utf8")) as {
    streams?: { codec_name?: string; pix_fmt?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0] ?? {};
  return {
    codec: stream.codec_name ?? null,
    pixelFormat: stream.pix_fmt ?? null,
    width: stream.width ?? null,
    height: stream.height ?? null,
    durationMs: parsed.format?.duration === undefined ? null : Math.round(Number(parsed.format.duration) * 1_000),
  };
}
