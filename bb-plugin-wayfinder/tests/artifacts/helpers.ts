import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ArtifactChunkReader } from "../../src/artifacts/http.js";
import { ArtifactStore, type PutArtifactInput } from "../../src/artifacts/store.js";

export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export function input(overrides: Partial<PutArtifactInput> = {}): PutArtifactInput {
  return {
    runId: "run_a",
    threadId: "thr_a",
    projectId: null,
    kind: "image",
    filename: "shot.png",
    mimeType: "image/png",
    redacted: false,
    sanitized: true,
    ...overrides,
  };
}

export async function tempStore(options: { quotaBytes?: number; retentionMs?: number; now?: () => number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-artifacts-"));
  const store = new ArtifactStore({ root, quotaBytes: options.quotaBytes ?? 64 * 1_048_576, ...options });
  return { root, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Local reader equivalent to the host `artifacts.readRange` RPC path. */
export function storeReader(store: ArtifactStore, calls: { start: number; end: number }[] = []): ArtifactChunkReader {
  return async (artifactId, start, endInclusive) => {
    calls.push({ start, end: endInclusive });
    const artifact = await store.getUnscoped(artifactId);
    if (artifact === null) {
      const { ArtifactError } = await import("../../src/artifacts/errors.js");
      throw new ArtifactError("not-found", "Artifact not found");
    }
    const chunk = await store.readRange(artifact, start, endInclusive);
    return { artifact, ...chunk };
  };
}
