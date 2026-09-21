import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { ArtifactRecord, ArtifactShareRecord } from "../contracts/artifact.js";
import {
  artifactHttpRoutes,
  artifactShareRecordSchema,
  createArtifactShareInputSchema,
  createArtifactShareOutputSchema,
} from "../contracts/artifact.js";
import { ArtifactError } from "./errors.js";

export const DEFAULT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * External sharing is disabled unless the integration has verified a public
 * HTTPS origin that reaches the unauthenticated export route. There is no
 * default and no guessed URL.
 */
export type ExternalShareAvailability =
  | { readonly state: "ready"; readonly exportBaseUrl: string }
  | { readonly state: "disabled"; readonly reason: string };

/** Persisted share row. Only a SHA-256 of the capability token is stored. */
export interface StoredShare {
  readonly record: ArtifactShareRecord;
  readonly tokenSha256: string;
  readonly artifactSha256: Readonly<Record<string, string>>;
}

export interface ShareStore {
  insert(share: StoredShare): void;
  get(shareId: string): StoredShare | null;
  update(share: StoredShare): void;
  listByRun(runId: string, threadId: string): StoredShare[];
  deleteFinishedBefore(cutoff: number): number;
}

export interface ShareServiceOptions {
  readonly store: ShareStore;
  readonly availability: () => ExternalShareAvailability;
  /** Loads artifacts for authorization; returns null when missing or expired. */
  readonly loadArtifact: (artifactId: string) => Promise<ArtifactRecord | null>;
  readonly now?: () => number;
}

const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const newShareId = (): string => `shr_${randomBytes(16).toString("hex")}`;

/** Canonical manifest digest: artifact IDs and content hashes in a stable order. */
export function manifestDigest(artifacts: readonly ArtifactRecord[]): string {
  const lines = [...artifacts]
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId))
    .map((artifact) => `${artifact.artifactId}\t${artifact.storage.immutableSha256}\t${artifact.media.mimeType}\n`);
  return sha256Hex(lines.join(""));
}

/**
 * Expiring, revocable, read-only exports over immutable artifacts. The share
 * capability is a 256-bit random token returned exactly once; the server keeps
 * only its hash, so no new secret is persisted and a database leak does not
 * yield working links.
 */
export class ShareService {
  readonly #store: ShareStore;
  readonly #availability: () => ExternalShareAvailability;
  readonly #loadArtifact: (artifactId: string) => Promise<ArtifactRecord | null>;
  readonly #now: () => number;

  constructor(options: ShareServiceOptions) {
    this.#store = options.store;
    this.#availability = options.availability;
    this.#loadArtifact = options.loadArtifact;
    this.#now = options.now ?? Date.now;
  }

  availability(): ExternalShareAvailability {
    const current = this.#availability();
    if (current.state === "ready" && !isHttpsBase(current.exportBaseUrl)) {
      return { state: "disabled", reason: "The configured export base URL is not an HTTPS URL." };
    }
    return current;
  }

  /**
   * Creates an export after explicit user approval in the UI. Every artifact
   * must belong to the caller's thread and run and must be sanitized.
   */
  async create(input: unknown, caller: { readonly threadId: string; readonly userId: string }) {
    const availability = this.availability();
    if (availability.state !== "ready") throw new ArtifactError("share-disabled", availability.reason);
    const parsed = createArtifactShareInputSchema.safeParse(input);
    if (!parsed.success) throw new ArtifactError("invalid-request", "Invalid share request");
    const { runId, artifactIds, expiresInSeconds, audience } = parsed.data;

    const artifacts: ArtifactRecord[] = [];
    for (const artifactId of artifactIds) {
      const artifact = await this.#loadArtifact(artifactId);
      if (artifact === null || artifact.threadId !== caller.threadId || artifact.runId !== runId) {
        throw new ArtifactError("not-found", "Artifact not found");
      }
      if (!artifact.sanitized) throw new ArtifactError("invalid-request", "Only sanitized artifacts can be shared");
      artifacts.push(artifact);
    }

    const now = this.#now();
    const token = randomBytes(32).toString("base64url");
    const record = artifactShareRecordSchema.parse({
      shareId: newShareId(),
      artifactIds,
      runId,
      threadId: caller.threadId,
      createdByUserId: caller.userId,
      createdAt: now,
      expiresAt: now + Math.min(expiresInSeconds, DEFAULT_SHARE_TTL_SECONDS) * 1_000,
      revokedAt: null,
      state: "active",
      audience,
      manifestSha256: manifestDigest(artifacts),
    });
    this.#store.insert({
      record,
      tokenSha256: sha256Hex(token),
      artifactSha256: Object.fromEntries(artifacts.map((artifact) => [artifact.artifactId, artifact.storage.immutableSha256])),
    });
    const url = new URL(availability.exportBaseUrl.replace(/\/+$/u, "") + artifactHttpRoutes.sharedExport);
    url.searchParams.set("share", record.shareId);
    url.searchParams.set("token", token);
    return createArtifactShareOutputSchema.parse({ share: record, url: url.toString() });
  }

  revoke(shareId: string, caller: { readonly threadId: string }): ArtifactShareRecord {
    const stored = this.#store.get(shareId);
    if (stored === null || stored.record.threadId !== caller.threadId) throw new ArtifactError("not-found", "Share not found");
    const current = this.#withState(stored.record);
    if (current.state !== "active") return current;
    const now = this.#now();
    const record = artifactShareRecordSchema.parse({ ...stored.record, revokedAt: now, state: "revoked" });
    this.#store.update({ ...stored, record });
    return record;
  }

  list(runId: string, threadId: string): ArtifactShareRecord[] {
    return this.#store.listByRun(runId, threadId).map((stored) => this.#withState(stored.record));
  }

  /**
   * Resolves an external request. Unknown, wrong-token, expired, and revoked
   * shares all fail; the handler maps them to the same 404.
   */
  async resolve(shareId: string, token: string, artifactId: string | null) {
    const stored = this.#store.get(shareId);
    if (stored === null || !tokenMatches(token, stored.tokenSha256)) throw new ArtifactError("not-found", "Share not found");
    const record = this.#withState(stored.record);
    if (record.state === "revoked") throw new ArtifactError("share-revoked", "Share revoked");
    if (record.state === "expired") throw new ArtifactError("share-expired", "Share expired");
    if (artifactId === null) return { share: record, artifact: null };
    if (!record.artifactIds.includes(artifactId)) throw new ArtifactError("not-found", "Artifact not in share");
    const artifact = await this.#loadArtifact(artifactId);
    if (artifact === null || artifact.storage.immutableSha256 !== stored.artifactSha256[artifactId]) {
      throw new ArtifactError("not-found", "Shared artifact is no longer available");
    }
    return { share: record, artifact };
  }

  /** Drops finished share rows after a grace period; artifacts themselves follow retention. */
  purge(graceMs = 24 * 60 * 60 * 1_000): number {
    return this.#store.deleteFinishedBefore(this.#now() - graceMs);
  }

  #withState(record: ArtifactShareRecord): ArtifactShareRecord {
    if (record.state !== "active") return record;
    return record.expiresAt <= this.#now() ? { ...record, state: "expired" } : record;
  }
}

function tokenMatches(token: string, expectedSha256: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(token), "hex"), Buffer.from(expectedSha256, "hex"));
}

function isHttpsBase(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

/** Minimal structural view of a better-sqlite3 handle (`bb.storage.database()`). */
export interface SqliteLike {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Append-only migrations for `bb.storage.migrate(db, SHARE_MIGRATIONS)`. */
export const SHARE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS wayfinder_shares (
    share_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    token_sha256 TEXT NOT NULL,
    record_json TEXT NOT NULL,
    artifact_sha256_json TEXT NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS wayfinder_shares_run ON wayfinder_shares (run_id, thread_id)`,
] as const;

export function createSqliteShareStore(db: SqliteLike): ShareStore {
  const decode = (row: unknown): StoredShare | null => {
    if (row === undefined || row === null) return null;
    const value = row as { record_json: string; token_sha256: string; artifact_sha256_json: string };
    const record = artifactShareRecordSchema.safeParse(JSON.parse(value.record_json));
    if (!record.success) return null;
    return {
      record: record.data,
      tokenSha256: value.token_sha256,
      artifactSha256: JSON.parse(value.artifact_sha256_json) as Record<string, string>,
    };
  };
  const finishedAt = (record: ArtifactShareRecord) => record.revokedAt ?? record.expiresAt;
  return {
    insert(share) {
      db.prepare(
        `INSERT INTO wayfinder_shares (share_id, run_id, thread_id, token_sha256, record_json, artifact_sha256_json, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        share.record.shareId,
        share.record.runId,
        share.record.threadId,
        share.tokenSha256,
        JSON.stringify(share.record),
        JSON.stringify(share.artifactSha256),
        finishedAt(share.record),
      );
    },
    get(shareId) {
      return decode(db.prepare(`SELECT * FROM wayfinder_shares WHERE share_id = ?`).get(shareId));
    },
    update(share) {
      db.prepare(`UPDATE wayfinder_shares SET record_json = ?, finished_at = ? WHERE share_id = ?`).run(
        JSON.stringify(share.record),
        finishedAt(share.record),
        share.record.shareId,
      );
    },
    listByRun(runId, threadId) {
      return db
        .prepare(`SELECT * FROM wayfinder_shares WHERE run_id = ? AND thread_id = ? ORDER BY share_id LIMIT 200`)
        .all(runId, threadId)
        .map(decode)
        .filter((share): share is StoredShare => share !== null);
    },
    deleteFinishedBefore(cutoff) {
      return db.prepare(`DELETE FROM wayfinder_shares WHERE finished_at < ?`).run(cutoff).changes;
    },
  };
}

export function createMemoryShareStore(): ShareStore {
  const rows = new Map<string, StoredShare>();
  return {
    insert: (share) => void rows.set(share.record.shareId, share),
    get: (shareId) => rows.get(shareId) ?? null,
    update: (share) => void rows.set(share.record.shareId, share),
    listByRun: (runId, threadId) =>
      [...rows.values()].filter((share) => share.record.runId === runId && share.record.threadId === threadId),
    deleteFinishedBefore(cutoff) {
      let removed = 0;
      for (const [id, share] of rows) {
        if ((share.record.revokedAt ?? share.record.expiresAt) < cutoff) {
          rows.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
