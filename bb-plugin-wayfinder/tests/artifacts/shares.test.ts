import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createSharedExportHandler } from "../../src/artifacts/exports.js";
import {
  createMemoryShareStore,
  createSqliteShareStore,
  SHARE_MIGRATIONS,
  ShareService,
  type ExternalShareAvailability,
  type ShareStore,
} from "../../src/artifacts/shares.js";
import { input, PNG_1X1, storeReader, tempStore } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const READY: ExternalShareAvailability = { state: "ready", exportBaseUrl: "https://share.example.test/api/v1/plugins/wayfinder/http" };
const caller = { threadId: "thr_a", userId: "bb-owner" };

async function setup(options: { availability?: ExternalShareAvailability; store?: ShareStore } = {}) {
  let now = 1_700_000_000_000;
  const created = await tempStore({ now: () => now });
  cleanups.push(created.cleanup);
  const shareStore = options.store ?? createMemoryShareStore();
  const shares = new ShareService({
    store: shareStore,
    availability: () => options.availability ?? READY,
    loadArtifact: (id) => created.store.getUnscoped(id),
    now: () => now,
  });
  const artifact = await created.store.put(input(), PNG_1X1);
  const handler = createSharedExportHandler(shares, storeReader(created.store));
  return {
    ...created,
    shares,
    shareStore,
    artifact,
    handler,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const request = (shareUrl: string, extra: Record<string, string> = {}) => {
  const target = new URL(shareUrl);
  for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);
  return new Request(target);
};

describe("ShareService", () => {
  it("stays disabled without a verified HTTPS export origin", async () => {
    const disabled = await setup({ availability: { state: "disabled", reason: "No public HTTPS export origin is verified." } });
    const body = { runId: "run_a", artifactIds: [disabled.artifact.artifactId], expiresInSeconds: 3_600, audience: "anyone-with-link" };
    await expect(disabled.shares.create(body, caller)).rejects.toMatchObject({ code: "share-disabled" });
    const plainHttp = await setup({ availability: { state: "ready", exportBaseUrl: "http://share.example.test" } });
    expect(plainHttp.shares.availability().state).toBe("disabled");
    const response = await disabled.handler(new Request("https://share.example.test/v1/exports/read?share=shr_x&token=x"));
    expect(response.status).toBe(503);
  });

  it("creates an HTTPS capability link whose token is never persisted", async () => {
    const { shares, artifact, shareStore } = await setup();
    const { share, url } = await shares.create(
      { runId: "run_a", artifactIds: [artifact.artifactId], expiresInSeconds: 3_600, audience: "anyone-with-link" },
      caller,
    );
    const token = new URL(url).searchParams.get("token")!;
    expect(new URL(url).protocol).toBe("https:");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(shareStore.get(share.shareId))).not.toContain(token);
    expect(share.expiresAt - share.createdAt).toBe(3_600_000);
  });

  it("serves shared files and the manifest only with the exact token", async () => {
    const { shares, artifact, handler } = await setup();
    const { url } = await shares.create(
      { runId: "run_a", artifactIds: [artifact.artifactId], expiresInSeconds: 3_600, audience: "anyone-with-link" },
      caller,
    );
    const manifest = await handler(request(url));
    expect(manifest.status).toBe(200);
    const body = (await manifest.json()) as { files: { artifactId: string }[] };
    expect(body.files.map((file) => file.artifactId)).toEqual([artifact.artifactId]);
    const file = await handler(request(url, { artifactId: artifact.artifactId }));
    expect(file.status).toBe(200);
    expect(file.headers.get("referrer-policy")).toBe("no-referrer");
    const wrongToken = await handler(request(url, { token: "A".repeat(43) }));
    expect(wrongToken.status).toBe(404);
    const notInShare = await handler(request(url, { artifactId: "art_other" }));
    expect(notInShare.status).toBe(404);
  });

  it("stops serving after expiry", async () => {
    const { shares, artifact, handler, advance } = await setup();
    const { url, share } = await shares.create(
      { runId: "run_a", artifactIds: [artifact.artifactId], expiresInSeconds: 60, audience: "anyone-with-link" },
      caller,
    );
    advance(59_999);
    expect((await handler(request(url))).status).toBe(200);
    advance(1);
    expect((await handler(request(url, { artifactId: artifact.artifactId }))).status).toBe(404);
    expect(shares.list("run_a", "thr_a").find((row) => row.shareId === share.shareId)?.state).toBe("expired");
  });

  it("stops serving after revocation, and only the owning thread can revoke", async () => {
    const { shares, artifact, handler } = await setup();
    const { url, share } = await shares.create(
      { runId: "run_a", artifactIds: [artifact.artifactId], expiresInSeconds: 3_600, audience: "anyone-with-link" },
      caller,
    );
    expect(() => shares.revoke(share.shareId, { threadId: "thr_b" })).toThrow(expect.objectContaining({ code: "not-found" }));
    expect((await handler(request(url))).status).toBe(200);
    const revoked = shares.revoke(share.shareId, { threadId: "thr_a" });
    expect(revoked.state).toBe("revoked");
    expect((await handler(request(url, { artifactId: artifact.artifactId }))).status).toBe(404);
  });

  it("refuses to export another thread's, another run's, or unsanitized artifacts", async () => {
    const { shares, store, artifact } = await setup();
    const make = (artifactIds: string[], runId = "run_a") =>
      shares.create({ runId, artifactIds, expiresInSeconds: 3_600, audience: "anyone-with-link" }, caller);
    const foreign = await store.put(input({ threadId: "thr_b" }), PNG_1X1);
    await expect(make([artifact.artifactId, foreign.artifactId])).rejects.toMatchObject({ code: "not-found" });
    await expect(make([artifact.artifactId], "run_b")).rejects.toMatchObject({ code: "not-found" });
    const raw = await store.put(input({ sanitized: false }), PNG_1X1);
    await expect(make([raw.artifactId])).rejects.toMatchObject({ code: "invalid-request" });
    await expect(make([artifact.artifactId, artifact.artifactId])).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("caps expiry at seven days", async () => {
    const { shares, artifact } = await setup();
    await expect(
      shares.create({ runId: "run_a", artifactIds: [artifact.artifactId], expiresInSeconds: 604_801, audience: "anyone-with-link" }, caller),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("persists hashed shares in the plugin SQLite database", async () => {
    const db = new Database(":memory:");
    for (const statement of SHARE_MIGRATIONS) db.exec(statement);
    const { shares, artifact, handler, advance } = await setup({ store: createSqliteShareStore(db) });
    const { url, share } = await shares.create(
      { runId: "run_a", artifactIds: [artifact.artifactId], expiresInSeconds: 60, audience: "anyone-with-link" },
      caller,
    );
    expect((await handler(request(url))).status).toBe(200);
    const token = new URL(url).searchParams.get("token")!;
    const rows = JSON.stringify(db.prepare("SELECT * FROM wayfinder_shares").all());
    expect(rows).not.toContain(token);
    advance(60_000 + 24 * 60 * 60 * 1_000 + 1);
    expect(shares.purge()).toBe(1);
    expect(shares.list("run_a", "thr_a").map((row) => row.shareId)).not.toContain(share.shareId);
    db.close();
  });
});
