import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createInternalArtifactHandlers, parseRangeHeader } from "../../src/artifacts/http.js";
import { MAX_RANGE_BYTES } from "../../src/artifacts/store.js";
import { input, PNG_1X1, storeReader, tempStore } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function setup() {
  const created = await tempStore();
  cleanups.push(created.cleanup);
  const calls: { start: number; end: number }[] = [];
  return { ...created, calls, handlers: createInternalArtifactHandlers(storeReader(created.store, calls)) };
}

const url = (route: string, params: Record<string, string>) =>
  `http://bb.local/api/v1/plugins/wayfinder/http${route}?${new URLSearchParams(params).toString()}`;

function fakeMp4(size: number): Buffer {
  const bytes = randomBytes(size);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftypisom", 4, "latin1");
  return bytes;
}

describe("parseRangeHeader", () => {
  it("parses single byte ranges and rejects the rest", () => {
    expect(parseRangeHeader("bytes=0-99", 1_000)).toEqual({ start: 0, endInclusive: 99 });
    expect(parseRangeHeader("bytes=900-", 1_000)).toEqual({ start: 900, endInclusive: 999 });
    expect(parseRangeHeader("bytes=-100", 1_000)).toEqual({ start: 900, endInclusive: 999 });
    expect(parseRangeHeader("bytes=0-5000", 1_000)).toEqual({ start: 0, endInclusive: 999 });
    expect(parseRangeHeader("bytes=1000-", 1_000)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=0-1,5-9", 1_000)).toBeNull();
    expect(parseRangeHeader("items=0-1", 1_000)).toBeNull();
    expect(parseRangeHeader("bytes=9-1", 1_000)).toBeNull();
  });
});

describe("internal artifact routes", () => {
  it("serves an owned image inline with private, sandboxed headers", async () => {
    const { store, handlers } = await setup();
    const record = await store.put(input(), PNG_1X1);
    const response = await handlers.inline(new Request(url("/v1/artifacts/inline", { artifactId: record.artifactId, threadId: "thr_a" })));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG_1X1)).toBe(true);
  });

  it("returns 404 for another thread's artifact, identical to a missing one", async () => {
    const { store, handlers } = await setup();
    const record = await store.put(input(), PNG_1X1);
    const foreign = await handlers.inline(new Request(url("/v1/artifacts/inline", { artifactId: record.artifactId, threadId: "thr_b" })));
    const missing = await handlers.inline(new Request(url("/v1/artifacts/inline", { artifactId: "art_missing", threadId: "thr_a" })));
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });

  it("rejects traversal-shaped and duplicated IDs before touching storage", async () => {
    const { handlers, calls } = await setup();
    for (const params of [
      "artifactId=..%2F..%2Fetc%2Fpasswd&threadId=thr_a",
      "artifactId=art_a&artifactId=art_b&threadId=thr_a",
      "threadId=thr_a",
    ]) {
      const response = await handlers.download(new Request(`http://bb.local/x?${params}`));
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("never renders HTML inline and downloads it as an opaque sandboxed attachment", async () => {
    const { store, handlers } = await setup();
    const record = await store.put(
      input({ kind: "report", filename: "report.html", mimeType: "text/html" }),
      Buffer.from("<html><script>fetch('/api/v1/threads')</script></html>"),
    );
    const params = { artifactId: record.artifactId, threadId: "thr_a" };
    const inline = await handlers.inline(new Request(url("/v1/artifacts/inline", params)));
    expect(inline.status).toBe(415);
    const download = await handlers.download(new Request(url("/v1/artifacts/download", params)));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="report\.html"/u);
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("answers video range requests with bounded 206 chunks", async () => {
    const { store, handlers } = await setup();
    const video = fakeMp4(MAX_RANGE_BYTES * 2 + 17);
    const record = await store.put(input({ kind: "video", filename: "clip.mp4", mimeType: "video/mp4" }), video);
    const params = { artifactId: record.artifactId, threadId: "thr_a" };
    const open = await handlers.inline(new Request(url("/v1/artifacts/inline", params), { headers: { range: "bytes=0-" } }));
    expect(open.status).toBe(206);
    expect(open.headers.get("accept-ranges")).toBe("bytes");
    expect(open.headers.get("content-range")).toBe(`bytes 0-${MAX_RANGE_BYTES - 1}/${video.length}`);
    const tail = await handlers.inline(new Request(url("/v1/artifacts/inline", params), { headers: { range: "bytes=-17" } }));
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(video.subarray(-17))).toBe(true);
    const beyond = await handlers.inline(new Request(url("/v1/artifacts/inline", params), { headers: { range: `bytes=${video.length}-` } }));
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${video.length}`);
  });

  it("streams full downloads chunk by chunk, pulling only as a slow client reads", async () => {
    const { store, handlers, calls } = await setup();
    const video = fakeMp4(MAX_RANGE_BYTES * 3 + 5);
    const record = await store.put(input({ kind: "video", filename: "clip.mp4", mimeType: "video/mp4" }), video);
    const response = await handlers.download(new Request(url("/v1/artifacts/download", { artifactId: record.artifactId, threadId: "thr_a" })));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(video.length));
    // Before the client reads, at most the first chunk plus one prefetch is buffered.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.length).toBeLessThanOrEqual(2);
    const reader = response.body!.getReader();
    const received: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.length).toBeLessThanOrEqual(MAX_RANGE_BYTES);
      received.push(Buffer.from(value));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(Buffer.concat(received).equals(video)).toBe(true);
    expect(calls.every((call) => call.end - call.start < MAX_RANGE_BYTES)).toBe(true);
  });
});
