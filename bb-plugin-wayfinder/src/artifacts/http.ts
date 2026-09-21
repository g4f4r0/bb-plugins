import type { ArtifactRecord } from "../contracts/artifact.js";
import { entityIdSchema } from "../contracts/primitives.js";
import { ArtifactError, isArtifactError } from "./errors.js";
import { isInlineRenderable } from "./mime.js";
import { MAX_RANGE_BYTES } from "./store.js";

/**
 * Reads one bounded chunk. The integration wires this to the host
 * `artifacts.readRange` RPC (or the local store when host and server share a
 * process). It must return the record so the caller can authorize it.
 */
export type ArtifactChunkReader = (
  artifactId: string,
  start: number,
  endInclusive: number,
  signal: AbortSignal,
) => Promise<{ artifact: ArtifactRecord; bytes: Uint8Array; start: number; endInclusive: number }>;

export type ArtifactAuthorizer = (artifact: ArtifactRecord) => boolean;

export type ByteRange = { readonly start: number; readonly endInclusive: number };

/**
 * Parses a single `bytes=` range. Multi-range, malformed, and non-byte units
 * return null so the caller serves a normal full response.
 */
export function parseRangeHeader(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), endInclusive: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { start, endInclusive: Math.min(end, size - 1) };
}

export const PRIVATE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // Even if a browser rendered the body as a document, it gets no script,
  // no same-origin access, and no subresources.
  "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...PRIVATE_RESPONSE_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

export function artifactErrorResponse(error: unknown): Response {
  if (!isArtifactError(error)) return errorResponse(500, "internal", "Artifact delivery failed");
  switch (error.code) {
    case "not-found":
    case "share-expired":
    case "share-revoked":
      // Expired, revoked, and foreign artifacts are deliberately indistinguishable.
      return errorResponse(404, "not-found", "Artifact not found or no longer shared");
    case "range-not-satisfiable":
      return errorResponse(416, error.code, error.message);
    case "share-disabled":
      return errorResponse(503, error.code, error.message);
    case "invalid-request":
      return errorResponse(400, error.code, error.message);
    default:
      return errorResponse(500, error.code, "Artifact delivery failed");
  }
}

export interface ServeArtifactOptions {
  readonly request: Request;
  readonly artifactId: string;
  readonly disposition: "inline" | "attachment";
  readonly read: ArtifactChunkReader;
  readonly authorize: ArtifactAuthorizer;
}

/**
 * Serves an artifact with bounded memory. A Range request gets one 206 chunk
 * of at most 1 MiB (players request the next one). A full response streams
 * 1 MiB chunks with pull-based backpressure, so a slow client only slows its
 * own response and never buffers the whole file.
 */
export async function serveArtifact(options: ServeArtifactOptions): Promise<Response> {
  const { request, artifactId, disposition, read, authorize } = options;
  const signal = request.signal;
  try {
    const first = await read(artifactId, 0, MAX_RANGE_BYTES - 1, signal);
    const artifact = first.artifact;
    if (artifact.artifactId !== artifactId || !authorize(artifact)) throw new ArtifactError("not-found", "Artifact not found");
    if (disposition === "inline" && !isInlineRenderable(artifact.media.mimeType)) {
      return errorResponse(415, "not-inline", "This artifact type is download-only");
    }

    const size = artifact.media.sizeBytes;
    const headers = new Headers(PRIVATE_RESPONSE_HEADERS);
    // HTML and other active types are never labelled as themselves on download.
    headers.set("content-type", disposition === "inline" ? artifact.media.mimeType : safeDownloadType(artifact.media.mimeType));
    headers.set("content-disposition", contentDisposition(disposition, artifact.media.filename));
    headers.set("accept-ranges", "bytes");
    headers.set("etag", `"${artifact.media.sha256}"`);

    const range = parseRangeHeader(request.headers.get("range"), size);
    if (range === "unsatisfiable") {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range !== null) {
      const endInclusive = Math.min(range.endInclusive, range.start + MAX_RANGE_BYTES - 1);
      const chunk =
        range.start === 0 && endInclusive <= first.endInclusive
          ? { artifact, bytes: first.bytes.subarray(0, endInclusive + 1), start: 0, endInclusive }
          : await read(artifactId, range.start, endInclusive, signal);
      assertSameArtifact(chunk, artifact);
      headers.set("content-range", `bytes ${chunk.start}-${chunk.endInclusive}/${size}`);
      headers.set("content-length", String(chunk.bytes.length));
      return new Response(copyBytes(chunk.bytes), { status: 206, headers });
    }

    headers.set("content-length", String(size));
    if (first.endInclusive >= size - 1) return new Response(copyBytes(first.bytes), { status: 200, headers });
    let next = first.endInclusive + 1;
    let pending: Uint8Array | null = first.bytes;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (pending !== null) {
            controller.enqueue(pending);
            pending = null;
            return;
          }
          if (next >= size) {
            controller.close();
            return;
          }
          const chunk = await read(artifactId, next, Math.min(size - 1, next + MAX_RANGE_BYTES - 1), signal);
          assertSameArtifact(chunk, artifact);
          next = chunk.endInclusive + 1;
          controller.enqueue(chunk.bytes);
        },
      },
      { highWaterMark: 1 },
    );
    return new Response(body, { status: 200, headers });
  } catch (error) {
    return artifactErrorResponse(error);
  }
}

function assertSameArtifact(chunk: { artifact?: ArtifactRecord }, artifact: ArtifactRecord): void {
  if (chunk.artifact !== undefined && chunk.artifact.storage.immutableSha256 !== artifact.storage.immutableSha256) {
    throw new ArtifactError("integrity", "Artifact changed during delivery");
  }
}

function safeDownloadType(mimeType: string): string {
  return isInlineRenderable(mimeType) || mimeType === "application/json" || mimeType === "text/plain"
    ? mimeType
    : "application/octet-stream";
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/** Reads required opaque IDs from a query string; anything else is a 400. */
export function readIdParams<const Keys extends readonly string[]>(
  url: URL,
  keys: Keys,
): { [Key in Keys[number]]: string } {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const values = url.searchParams.getAll(key);
    const parsed = values.length === 1 ? entityIdSchema.safeParse(values[0]) : null;
    if (parsed === null || !parsed.success) throw new ArtifactError("invalid-request", `Missing or invalid ${key}`);
    result[key] = parsed.data;
  }
  return result as { [Key in Keys[number]]: string };
}

/**
 * Authenticated internal routes. Mount with `bb.http.route("GET",
 * artifactHttpRoutes.inline|download, …, { auth: "local" })`. The thread ID in
 * the query must own the artifact; a foreign thread gets a 404.
 */
export function createInternalArtifactHandlers(read: ArtifactChunkReader) {
  const handle = (disposition: "inline" | "attachment") => async (request: Request): Promise<Response> => {
    try {
      const { artifactId, threadId } = readIdParams(new URL(request.url), ["artifactId", "threadId"] as const);
      return await serveArtifact({
        request,
        artifactId,
        disposition,
        read,
        authorize: (artifact) => artifact.threadId === threadId,
      });
    } catch (error) {
      return artifactErrorResponse(error);
    }
  };
  return { inline: handle("inline"), download: handle("attachment") };
}
