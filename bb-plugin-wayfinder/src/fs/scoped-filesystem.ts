import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { Checkpoint, DataReference, WayfinderRoute } from "../contracts/route.js";
import type { CheckpointResult } from "../contracts/run.js";
import { relativePathSchema } from "../contracts/primitives.js";
import { errorMessage, wayfinderError } from "../core/errors.js";

export type DataResolver = (reference: DataReference, signal: AbortSignal) => Promise<string>;

export interface ScopedEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
  readonly size: number;
}

export class ScopedFilesystem {
  readonly #roots: ReadonlyMap<string, WayfinderRoute["filesystem"]["roots"][number]>;
  readonly #maxReadBytes: number;

  constructor(roots: WayfinderRoute["filesystem"]["roots"], options: { maxReadBytes?: number } = {}) {
    this.#roots = new Map(roots.map((root) => [root.rootId, root]));
    this.#maxReadBytes = options.maxReadBytes ?? 1_048_576;
  }

  rootIds(): string[] {
    return [...this.#roots.keys()];
  }

  async resolveExisting(rootId: string, relativePath: string): Promise<string> {
    relativePathSchema.parse(relativePath);
    const root = this.#root(rootId);
    const rootStat = await lstat(root.absolutePath).catch((error: unknown) => {
      throw wayfinderError("setup-required", "verify", `Filesystem root is unavailable: ${errorMessage(error)}`);
    });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw wayfinderError("policy-denied", "verify", "Filesystem root must be a real directory, not a symlink");
    }
    const rootReal = await realpath(root.absolutePath).catch((error: unknown) => {
      throw wayfinderError("setup-required", "verify", `Filesystem root is unavailable: ${errorMessage(error)}`);
    });
    const candidate = resolve(rootReal, relativePath);
    this.#assertContained(rootReal, candidate);
    await this.#rejectSymlinkSegments(rootReal, relativePath);
    const candidateReal = await realpath(candidate);
    this.#assertContained(rootReal, candidateReal);
    return candidateReal;
  }

  async read(rootId: string, relativePath: string, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) throw wayfinderError("cancelled", "verify", "Filesystem read cancelled");
    const path = await this.resolveExisting(rootId, relativePath);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw wayfinderError("verification-failed", "verify", "Scoped path is not a file");
      if (stat.size > this.#maxReadBytes) throw wayfinderError("limit-exceeded", "verify", "Scoped file exceeds the read limit");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async list(rootId: string, relativePath: string, maxEntries = 1_000): Promise<ScopedEntry[]> {
    const path = await this.resolveExisting(rootId, relativePath);
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length > maxEntries) throw wayfinderError("limit-exceeded", "verify", "Directory entry limit exceeded");
    return Promise.all(entries.map(async (entry) => {
      if (entry.isSymbolicLink()) throw wayfinderError("policy-denied", "verify", "Symbolic links are not exposed through scoped listing");
      const stat = await lstat(join(path, entry.name));
      return {
        name: entry.name,
        type: stat.isFile() ? "file" as const : stat.isDirectory() ? "directory" as const : "other" as const,
        size: stat.size,
      };
    }));
  }

  async verify(checkpoint: Checkpoint, resolveData: DataResolver, signal: AbortSignal): Promise<CheckpointResult> {
    const observedAt = Date.now();
    if (checkpoint.kind !== "filesystem") {
      return { checkpoint, outcome: "unknown", observedAt, summary: "Checkpoint is not a filesystem predicate", evidenceArtifactIds: [] };
    }
    let path: string;
    try {
      path = await this.resolveExisting(checkpoint.rootId, checkpoint.relativePath);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (checkpoint.assertion.kind === "missing" && missing) {
        return { checkpoint, outcome: "pass", observedAt, summary: "Scoped path is missing", evidenceArtifactIds: [] };
      }
      if (missing) return { checkpoint, outcome: "fail", observedAt, summary: "Scoped path does not exist", evidenceArtifactIds: [] };
      throw error;
    }
    const stat = await lstat(path);
    let pass = false;
    let summary = "Filesystem predicate did not match";
    switch (checkpoint.assertion.kind) {
      case "exists": {
        const type = checkpoint.assertion.entryType;
        pass = type === "either" || (type === "file" ? stat.isFile() : stat.isDirectory());
        summary = pass ? `Scoped ${type} exists` : "Scoped path has the wrong entry type";
        break;
      }
      case "missing":
        pass = false;
        summary = "Scoped path exists";
        break;
      case "sha256": {
        if (!stat.isFile()) break;
        const digest = await this.#sha256(path, signal);
        pass = digest === checkpoint.assertion.sha256;
        summary = pass ? "File SHA-256 matches" : "File SHA-256 differs";
        break;
      }
      case "content": {
        const actual = (await this.read(checkpoint.rootId, checkpoint.relativePath, signal)).toString("utf8");
        const expected = await resolveData(checkpoint.assertion.expected, signal);
        pass = checkpoint.assertion.comparison === "equals" ? actual === expected : actual.includes(expected);
        summary = pass ? "File content predicate matches" : "File content predicate differs";
        break;
      }
    }
    return { checkpoint, outcome: pass ? "pass" : "fail", observedAt, summary, evidenceArtifactIds: [] };
  }

  #root(rootId: string): WayfinderRoute["filesystem"]["roots"][number] {
    const root = this.#roots.get(rootId);
    if (root === undefined) throw wayfinderError("policy-denied", "verify", "Filesystem root is not declared");
    return root;
  }

  #assertContained(root: string, candidate: string): void {
    const rel = relative(root, candidate);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) return;
    throw wayfinderError("policy-denied", "verify", "Filesystem path escapes its declared root");
  }

  async #rejectSymlinkSegments(root: string, relativePath: string): Promise<void> {
    let current = root;
    for (const segment of relativePath.split("/")) {
      current = join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw wayfinderError("policy-denied", "verify", "Symbolic links are forbidden in scoped paths");
    }
  }

  async #sha256(path: string, signal: AbortSignal): Promise<string> {
    const hash = createHash("sha256");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > this.#maxReadBytes) {
      await handle.close();
      throw wayfinderError("limit-exceeded", "verify", "Scoped file exceeds the verification limit");
    }
    const stream = handle.createReadStream({ autoClose: false });
    const abort = () => stream.destroy(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of stream) hash.update(chunk as Buffer);
      return hash.digest("hex");
    } catch (error) {
      if (signal.aborted) throw wayfinderError("cancelled", "verify", "Filesystem hash cancelled");
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await handle.close();
    }
  }
}

export const defaultDataResolver: DataResolver = async (reference) => {
  if (reference.kind === "synthetic-literal") return reference.value;
  throw wayfinderError("setup-required", "verify", "Protected data resolver is not configured");
};
