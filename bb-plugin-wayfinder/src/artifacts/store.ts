import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord } from "../contracts/artifact.js";
import { artifactRecordSchema } from "../contracts/artifact.js";
import type { MediaDescriptor } from "../contracts/media.js";
import { entityIdSchema, relativePathSchema } from "../contracts/primitives.js";
import { ArtifactError } from "./errors.js";
import { contentMatchesMimeType, extensionFor, isArtifactMimeType, type ArtifactMimeType } from "./mime.js";

export const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_ARTIFACT_BYTES = 536_870_912;
export const MAX_RANGE_BYTES = 1_048_576;
const MAX_INDEXED_ARTIFACTS = 20_000;

export interface ArtifactStoreOptions {
  /** Absolute private directory, normally `<host dataDir>/artifacts`. */
  readonly root: string;
  /** Total stored bytes allowed; unexpired evidence is never evicted to make room. */
  readonly quotaBytes: number;
  /** Local retention; configurable downwards from 30 days. */
  readonly retentionMs?: number;
  readonly now?: () => number;
}

export interface ArtifactScope {
  readonly threadId: string;
  readonly runId?: string | null;
}

export interface PutArtifactInput {
  readonly runId: string;
  readonly threadId: string;
  readonly projectId: string | null;
  readonly kind: MediaDescriptor["kind"];
  readonly filename: string;
  readonly mimeType: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly captureStartedAt?: number | null;
  readonly captureEndedAt?: number | null;
  readonly redacted: boolean;
  readonly sanitized: boolean;
}

const newArtifactId = (): string => `art_${randomBytes(16).toString("hex")}`;

/** Display names never carry directories, control characters, or a misleading extension. */
export function safeDisplayFilename(requested: string, mimeType: ArtifactMimeType): string {
  const extension = extensionFor(mimeType);
  const base = (requested.split(/[\\/]/u).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/gu, "")
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 120);
  return `${base.length > 0 ? base : "artifact"}.${extension}`;
}

/**
 * Host-private, immutable artifact storage. Blobs are content-verified,
 * written atomically under generated paths, and read with O_NOFOLLOW so a
 * swapped symlink cannot redirect a read outside the root.
 */
export class ArtifactStore {
  readonly #root: string;
  readonly #quotaBytes: number;
  readonly #retentionMs: number;
  readonly #now: () => number;
  #index: Map<string, ArtifactRecord> | null = null;
  // Commits run one at a time so concurrent writers cannot both pass the quota check.
  #commits: Promise<unknown> = Promise.resolve();

  constructor(options: ArtifactStoreOptions) {
    if (!path.isAbsolute(options.root)) throw new ArtifactError("invalid-request", "Artifact root must be absolute");
    if (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes <= 0) {
      throw new ArtifactError("invalid-request", "Artifact quota must be a positive integer");
    }
    const retention = options.retentionMs ?? MAX_RETENTION_MS;
    if (!Number.isSafeInteger(retention) || retention <= 0 || retention > MAX_RETENTION_MS) {
      throw new ArtifactError("invalid-request", "Artifact retention must be between 1 ms and 30 days");
    }
    this.#root = path.resolve(options.root);
    this.#quotaBytes = options.quotaBytes;
    this.#retentionMs = retention;
    this.#now = options.now ?? Date.now;
  }

  async put(input: PutArtifactInput, bytes: Uint8Array): Promise<ArtifactRecord> {
    const staging = await this.#stagingPath();
    await writeFile(staging, bytes, { flag: "wx", mode: 0o600 });
    return this.#commit(input, staging);
  }

  /**
   * Imports a file produced by a Wayfinder-owned process (for example an
   * encoder output in the host temp dir). The source must be a regular file,
   * not a symlink; it is copied, never moved, so the caller keeps cleanup.
   */
  async importFile(input: PutArtifactInput, sourcePath: string): Promise<ArtifactRecord> {
    if (!path.isAbsolute(sourcePath)) throw new ArtifactError("invalid-request", "Source path must be absolute");
    const info = await lstat(sourcePath);
    if (!info.isFile()) throw new ArtifactError("invalid-content", "Artifact source must be a regular file");
    if (info.size > MAX_ARTIFACT_BYTES) throw new ArtifactError("too-large", "Artifact exceeds the 512 MiB limit");
    const staging = await this.#stagingPath();
    const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const target = await open(staging, "wx", 0o600);
      try {
        for await (const chunk of source.createReadStream({ autoClose: false, highWaterMark: 1_048_576 })) {
          await target.write(chunk as Buffer);
        }
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
    return this.#commit(input, staging);
  }

  async get(artifactId: string, scope: ArtifactScope): Promise<ArtifactRecord> {
    const record = (await this.#loadIndex()).get(artifactId);
    // Cross-scope lookups are indistinguishable from missing artifacts.
    if (record === undefined || !inScope(record, scope) || record.retentionExpiresAt <= this.#now()) {
      throw new ArtifactError("not-found", "Artifact not found");
    }
    return record;
  }

  /** Internal lookup for share resolution, which authorizes by share manifest instead of thread. */
  async getUnscoped(artifactId: string): Promise<ArtifactRecord | null> {
    const record = (await this.#loadIndex()).get(artifactId);
    return record !== undefined && record.retentionExpiresAt > this.#now() ? record : null;
  }

  async list(scope: ArtifactScope & { readonly cursor: string | null; readonly limit: number }) {
    const limit = Math.max(1, Math.min(100, Math.trunc(scope.limit)));
    const now = this.#now();
    const matches = [...(await this.#loadIndex()).values()]
      .filter((record) => inScope(record, scope) && record.retentionExpiresAt > now)
      .sort((a, b) => b.media.createdAt - a.media.createdAt || a.artifactId.localeCompare(b.artifactId));
    const start = scope.cursor === null ? 0 : matches.findIndex((record) => record.artifactId === scope.cursor) + 1;
    if (scope.cursor !== null && start === 0) throw new ArtifactError("invalid-request", "Unknown cursor");
    const page = matches.slice(start, start + limit);
    const hasMore = start + limit < matches.length;
    return { artifacts: page, nextCursor: hasMore ? (page.at(-1)?.artifactId ?? null) : null };
  }

  /** Reads at most 1 MiB. `endInclusive` is clamped to the artifact size. */
  async readRange(record: ArtifactRecord, start: number, endInclusive: number): Promise<{ bytes: Buffer; start: number; endInclusive: number }> {
    const size = record.media.sizeBytes;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start) {
      throw new ArtifactError("range-not-satisfiable", "Invalid byte range");
    }
    if (start >= size) throw new ArtifactError("range-not-satisfiable", "Range starts beyond the artifact");
    const end = Math.min(endInclusive, size - 1, start + MAX_RANGE_BYTES - 1);
    const handle = await open(this.#blobPath(record), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== size) throw new ArtifactError("integrity", "Artifact size changed on disk");
      const bytes = Buffer.alloc(end - start + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) throw new ArtifactError("integrity", "Short artifact read");
      return { bytes, start, endInclusive: end };
    } finally {
      await handle.close();
    }
  }

  /** Full re-hash for integrity checks before export; streams, never buffers the whole blob. */
  async verify(record: ArtifactRecord): Promise<boolean> {
    const hash = createHash("sha256");
    const handle = await open(this.#blobPath(record), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    } finally {
      await handle.close();
    }
    return hash.digest("hex") === record.storage.immutableSha256;
  }

  async usedBytes(): Promise<number> {
    let total = 0;
    for (const record of (await this.#loadIndex()).values()) total += record.media.sizeBytes;
    return total;
  }

  async purgeExpired(): Promise<number> {
    const index = await this.#loadIndex();
    const now = this.#now();
    let removed = 0;
    for (const record of [...index.values()]) {
      if (record.retentionExpiresAt > now) continue;
      await rm(this.#blobPath(record), { force: true });
      await rm(this.#recordPath(record.artifactId), { force: true });
      index.delete(record.artifactId);
      removed += 1;
    }
    return removed;
  }

  #commit(input: PutArtifactInput, staging: string): Promise<ArtifactRecord> {
    const result = this.#commits.then(() => this.#commitNow(input, staging));
    this.#commits = result.catch(() => undefined);
    return result;
  }

  async #commitNow(input: PutArtifactInput, staging: string): Promise<ArtifactRecord> {
    try {
      if (!isArtifactMimeType(input.mimeType)) throw new ArtifactError("invalid-content", "Unsupported artifact type");
      entityIdSchema.parse(input.runId);
      entityIdSchema.parse(input.threadId);
      const { size, sha256, head } = await hashFile(staging);
      if (size === 0) throw new ArtifactError("invalid-content", "Artifact is empty");
      if (size > MAX_ARTIFACT_BYTES) throw new ArtifactError("too-large", "Artifact exceeds the 512 MiB limit");
      if (!contentMatchesMimeType(input.mimeType, head)) {
        throw new ArtifactError("invalid-content", "Artifact bytes do not match the declared type");
      }
      await this.purgeExpired();
      if ((await this.usedBytes()) + size > this.#quotaBytes) {
        throw new ArtifactError("quota-exceeded", "Artifact storage quota exceeded");
      }
      const index = await this.#loadIndex();
      if (index.size >= MAX_INDEXED_ARTIFACTS) throw new ArtifactError("quota-exceeded", "Artifact count limit reached");

      const now = this.#now();
      const artifactId = newArtifactId();
      const relativePath = relativePathSchema.parse(`blobs/${input.runId}/${artifactId}.${extensionFor(input.mimeType)}`);
      const record = artifactRecordSchema.parse({
        artifactId,
        runId: input.runId,
        threadId: input.threadId,
        projectId: input.projectId,
        media: {
          mediaId: artifactId,
          runId: input.runId,
          threadId: input.threadId,
          kind: input.kind,
          filename: safeDisplayFilename(input.filename, input.mimeType),
          mimeType: input.mimeType,
          sizeBytes: size,
          sha256,
          createdAt: now,
          width: input.width ?? null,
          height: input.height ?? null,
          durationMs: input.durationMs ?? null,
          captureStartedAt: input.captureStartedAt ?? null,
          captureEndedAt: input.captureEndedAt ?? null,
          redacted: input.redacted,
        },
        storage: { kind: "host-private", relativePath, immutableSha256: sha256 },
        sanitized: input.sanitized,
        retentionExpiresAt: now + this.#retentionMs,
      });
      const blob = this.#blobPath(record);
      await mkdir(path.dirname(blob), { recursive: true, mode: 0o700 });
      await rename(staging, blob);
      const recordFile = this.#recordPath(artifactId);
      await writeFile(`${recordFile}.tmp`, JSON.stringify(record), { mode: 0o600 });
      await rename(`${recordFile}.tmp`, recordFile);
      index.set(artifactId, record);
      return record;
    } finally {
      await rm(staging, { force: true });
    }
  }

  #blobPath(record: ArtifactRecord): string {
    const relative = relativePathSchema.parse(record.storage.relativePath);
    const resolved = path.resolve(this.#root, relative);
    if (!resolved.startsWith(`${this.#root}${path.sep}`)) throw new ArtifactError("integrity", "Artifact path escapes root");
    return resolved;
  }

  #recordPath(artifactId: string): string {
    return path.join(this.#root, "records", `${entityIdSchema.parse(artifactId)}.json`);
  }

  async #stagingPath(): Promise<string> {
    const dir = path.join(this.#root, "staging");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, randomBytes(12).toString("hex"));
  }

  async #loadIndex(): Promise<Map<string, ArtifactRecord>> {
    if (this.#index !== null) return this.#index;
    const dir = path.join(this.#root, "records");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const index = new Map<string, ArtifactRecord>();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path.join(dir, entry.name), "utf8"));
      } catch {
        continue;
      }
      const parsed = artifactRecordSchema.safeParse(raw);
      // Records failing the strict schema are ignored rather than trusted.
      if (parsed.success && `${parsed.data.artifactId}.json` === entry.name) index.set(parsed.data.artifactId, parsed.data);
      if (index.size >= MAX_INDEXED_ARTIFACTS) break;
    }
    this.#index = index;
    return index;
  }
}

function inScope(record: ArtifactRecord, scope: ArtifactScope): boolean {
  if (record.threadId !== scope.threadId) return false;
  return scope.runId === undefined || scope.runId === null || record.runId === scope.runId;
}

async function hashFile(file: string): Promise<{ size: number; sha256: string; head: Uint8Array }> {
  const hash = createHash("sha256");
  let size = 0;
  let head = new Uint8Array();
  for await (const chunk of createReadStream(file, { highWaterMark: 1_048_576 })) {
    const buffer = chunk as Buffer;
    if (head.length < 512) head = Buffer.concat([head, buffer.subarray(0, 512 - head.length)]);
    size += buffer.length;
    hash.update(buffer);
  }
  return { size, sha256: hash.digest("hex"), head };
}
