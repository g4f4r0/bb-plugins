import { runMediaProcess } from "./process.js";

export type ImagePurpose = "evidence" | "thumbnail";
export type OptimizedMimeType = "image/png" | "image/webp" | "image/jpeg";

export interface OptimizeImageOptions {
  readonly purpose: ImagePurpose;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface OptimizedImage {
  readonly bytes: Buffer;
  readonly mimeType: OptimizedMimeType;
  readonly width: number;
  readonly height: number;
  /** Every candidate tried, for measurement and reporting. */
  readonly candidates: readonly { mimeType: OptimizedMimeType; sizeBytes: number }[];
}

const MAX_INPUT_BYTES = 64 * 1_048_576;
const MAX_OUTPUT_BYTES = 32 * 1_048_576;

interface Candidate {
  readonly mimeType: OptimizedMimeType;
  readonly args: readonly string[];
}

/**
 * Evidence stays lossless so small UI text remains legible; the smaller of
 * lossless WebP and PNG wins. Thumbnails may be lossy; the smaller of WebP and
 * JPEG wins. Selection is by measured size, not a fixed format.
 */
function candidatesFor(purpose: ImagePurpose): Candidate[] {
  if (purpose === "evidence") {
    return [
      { mimeType: "image/webp", args: ["-c:v", "libwebp", "-lossless", "1", "-compression_level", "4", "-f", "webp"] },
      { mimeType: "image/png", args: ["-c:v", "png", "-pred", "mixed", "-f", "image2pipe"] },
    ];
  }
  return [
    { mimeType: "image/webp", args: ["-c:v", "libwebp", "-quality", "72", "-f", "webp"] },
    { mimeType: "image/jpeg", args: ["-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p", "-f", "image2pipe"] },
  ];
}

export async function optimizeImage(input: Uint8Array, options: OptimizeImageOptions): Promise<OptimizedImage> {
  if (input.length === 0 || input.length > MAX_INPUT_BYTES) throw new RangeError("Image input must be 1 byte to 64 MiB");
  const width = boundedDimension(options.maxWidth, 16, 7_680);
  const height = boundedDimension(options.maxHeight, 16, 4_320);
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? 20_000;
  // Downscale only; never upscale. Lanczos keeps text edges crisp.
  const scale = `scale='min(${width},iw)':'min(${height},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;

  const results = [];
  for (const candidate of candidatesFor(options.purpose)) {
    const bytes = await runMediaProcess({
      executable: ffmpeg,
      args: ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-vf", scale, ...candidate.args, "pipe:1"],
      stdin: input,
      timeoutMs,
      maxStdoutBytes: MAX_OUTPUT_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    results.push({ mimeType: candidate.mimeType, bytes });
  }
  results.sort((a, b) => a.bytes.length - b.bytes.length);
  const best = results[0]!;
  const dimensions = await probeDimensions(best.bytes, options.ffprobePath ?? "ffprobe", timeoutMs, options.signal);
  return {
    bytes: best.bytes,
    mimeType: best.mimeType,
    ...dimensions,
    candidates: results.map(({ mimeType, bytes }) => ({ mimeType, sizeBytes: bytes.length })),
  };
}

export async function probeDimensions(
  bytes: Uint8Array,
  ffprobe: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const output = await runMediaProcess({
    executable: ffprobe,
    args: ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", "-i", "pipe:0"],
    stdin: bytes,
    timeoutMs,
    maxStdoutBytes: 16_384,
    ...(signal === undefined ? {} : { signal }),
  });
  const stream = (JSON.parse(output.toString("utf8")) as { streams?: { width?: number; height?: number }[] }).streams?.[0];
  if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height)) throw new Error("Could not read image dimensions");
  return { width: stream!.width!, height: stream!.height! };
}

function boundedDimension(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`Dimension must be an integer from ${min} to ${max}`);
  return value;
}
