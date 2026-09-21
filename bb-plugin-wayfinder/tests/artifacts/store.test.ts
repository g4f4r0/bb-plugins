import { readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { safeDisplayFilename } from "../../src/artifacts/store.js";
import { input, PNG_1X1, tempStore } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function setup(options: Parameters<typeof tempStore>[0] = {}) {
  const created = await tempStore(options);
  cleanups.push(created.cleanup);
  return created;
}

describe("ArtifactStore", () => {
  it("stores immutable content under generated paths and scopes lookups to the owning thread", async () => {
    const { store } = await setup();
    const record = await store.put(input(), PNG_1X1);
    expect(record.storage.relativePath).toBe(`blobs/run_a/${record.artifactId}.png`);
    expect(record.media.sha256).toBe(record.storage.immutableSha256);
    await expect(store.get(record.artifactId, { threadId: "thr_a" })).resolves.toEqual(record);
    await expect(store.get(record.artifactId, { threadId: "thr_b" })).rejects.toMatchObject({ code: "not-found" });
    await expect(store.get(record.artifactId, { threadId: "thr_a", runId: "run_other" })).rejects.toMatchObject({ code: "not-found" });
    expect((await store.list({ threadId: "thr_b", cursor: null, limit: 10 })).artifacts).toEqual([]);
  });

  it("rejects bytes that do not match the declared type (HTML labelled as PNG)", async () => {
    const { store, root } = await setup();
    await expect(store.put(input(), Buffer.from("<script>alert(1)</script>"))).rejects.toMatchObject({ code: "invalid-content" });
    await expect(store.put(input({ mimeType: "image/svg+xml" }), Buffer.from("<svg/>"))).rejects.toMatchObject({ code: "invalid-content" });
    expect(await readdir(path.join(root, "staging"))).toEqual([]);
  });

  it("never lets a requested filename carry directories, controls, or a misleading extension", () => {
    expect(safeDisplayFilename("../../etc/passwd", "text/plain")).toBe("passwd.txt");
    expect(safeDisplayFilename("report.html", "image/png")).toBe("report.png");
    expect(safeDisplayFilename("..\\x\u0000\u0007y.exe", "image/png")).toBe("xy.png");
    expect(safeDisplayFilename("", "video/mp4")).toBe("artifact.mp4");
  });

  it("rejects unsafe run IDs instead of building paths from them", async () => {
    const { store } = await setup();
    await expect(store.put(input({ runId: "../escape" }), PNG_1X1)).rejects.toThrow();
  });

  it("refuses to follow a blob swapped for a symlink", async () => {
    const { store, root } = await setup();
    const record = await store.put(input(), PNG_1X1);
    const blob = path.join(root, record.storage.relativePath);
    const outside = path.join(root, "..", `outside-${record.artifactId}`);
    await writeFile(outside, "secret");
    cleanups.push(() => rm(outside, { force: true }));
    await rm(blob);
    await symlink(outside, blob);
    await expect(store.readRange(record, 0, 10)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("enforces the quota without evicting unexpired evidence", async () => {
    const { store } = await setup({ quotaBytes: PNG_1X1.length * 2 });
    const first = await store.put(input(), PNG_1X1);
    await store.put(input(), PNG_1X1);
    await expect(store.put(input(), PNG_1X1)).rejects.toMatchObject({ code: "quota-exceeded" });
    await expect(store.get(first.artifactId, { threadId: "thr_a" })).resolves.toBeDefined();
  });

  it("does not let concurrent writers overrun the quota together", async () => {
    const { store } = await setup({ quotaBytes: PNG_1X1.length * 2 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => store.put(input(), PNG_1X1)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(await store.usedBytes()).toBe(PNG_1X1.length * 2);
  });

  it("expires artifacts after retention and reclaims their space", async () => {
    let now = 1_000;
    const { store, root } = await setup({ quotaBytes: PNG_1X1.length, retentionMs: 60_000, now: () => now });
    const record = await store.put(input(), PNG_1X1);
    now += 60_000;
    await expect(store.get(record.artifactId, { threadId: "thr_a" })).rejects.toMatchObject({ code: "not-found" });
    await expect(store.put(input(), PNG_1X1)).resolves.toBeDefined();
    expect(await readdir(path.join(root, "records"))).toHaveLength(1);
  });

  it("rejects retention above 30 days", async () => {
    await expect(setup({ retentionMs: 31 * 24 * 60 * 60 * 1_000 })).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("clamps range reads to the artifact and to 1 MiB", async () => {
    const { store } = await setup();
    const record = await store.put(input(), PNG_1X1);
    const chunk = await store.readRange(record, 4, 10_000_000);
    expect(chunk.endInclusive).toBe(PNG_1X1.length - 1);
    expect(chunk.bytes.equals(PNG_1X1.subarray(4))).toBe(true);
    await expect(store.readRange(record, PNG_1X1.length, PNG_1X1.length + 1)).rejects.toMatchObject({ code: "range-not-satisfiable" });
    expect(await store.verify(record)).toBe(true);
  });

  it("ignores tampered or foreign record files on reload", async () => {
    const { store, root } = await setup();
    const record = await store.put(input(), PNG_1X1);
    await writeFile(path.join(root, "records", "art_forged.json"), JSON.stringify({ ...record, artifactId: "art_forged", extra: 1 }));
    await writeFile(path.join(root, "records", "art_broken.json"), "{");
    const { ArtifactStore } = await import("../../src/artifacts/store.js");
    const reloaded = new ArtifactStore({ root, quotaBytes: 1_048_576 });
    await expect(reloaded.getUnscoped("art_forged")).resolves.toBeNull();
    await expect(reloaded.getUnscoped(record.artifactId)).resolves.toEqual(record);
  });
});
