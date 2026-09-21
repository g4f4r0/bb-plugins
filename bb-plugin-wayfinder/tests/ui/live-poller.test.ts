import { afterEach, describe, expect, it } from "vitest";

import { LiveFramePoller, type LiveViewState } from "../../components/live-poller.js";
import { LIVE_FRAME_HEADERS } from "../../src/media/routes.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function frameResponse(sequence: number, ageMs = 40): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: {
      "content-type": "image/webp",
      [LIVE_FRAME_HEADERS.sequence]: String(sequence),
      [LIVE_FRAME_HEADERS.state]: "live",
      [LIVE_FRAME_HEADERS.ageMs]: String(ageMs),
    },
  });
}

function stateResponse(state: string, sequence = 1): Response {
  return new Response(null, {
    status: 204,
    headers: { [LIVE_FRAME_HEADERS.state]: state, [LIVE_FRAME_HEADERS.sequence]: String(sequence), [LIVE_FRAME_HEADERS.ageMs]: "5" },
  });
}

function harness(respond: (url: URL, call: number, signal: AbortSignal) => Promise<Response>, options: { hidden?: () => boolean } = {}) {
  const states: LiveViewState[] = [];
  const urls: URL[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const poller = new LiveFramePoller({
    runId: "run_a",
    onState: (state) => states.push(state),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://bb.local");
      urls.push(url);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        return await respond(url, urls.length, init!.signal!);
      } finally {
        inflight -= 1;
      }
    }) as typeof fetch,
    createObjectURL: () => {
      const url = `blob:frame-${created.length + 1}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
    isHidden: options.hidden ?? (() => false),
    minIntervalMs: 5,
    requestTimeoutMs: 1_000,
    maxBackoffMs: 20,
  });
  return { poller, states, urls, created, revoked, latest: () => states.at(-1), maxInflight: () => maxInflight };
}

let active: LiveFramePoller | null = null;
afterEach(() => {
  active?.stop();
  active = null;
});

describe("LiveFramePoller", () => {
  it("keeps one request in flight so a slow viewer lowers its own frame rate instead of queueing", async () => {
    let sequence = 0;
    const h = harness(async () => {
      await tick(40);
      sequence += 1;
      return frameResponse(sequence);
    });
    active = h.poller;
    h.poller.start();
    h.poller.start(); // idempotent
    await tick(150);
    expect(h.maxInflight()).toBe(1);
    expect(h.urls.length).toBeLessThanOrEqual(4);
    expect(h.latest()).toMatchObject({ status: "live", frameAgeMs: 40 });
  });

  it("asks only for newer frames and keeps pixels while the frame is unchanged", async () => {
    const h = harness(async (_url, call) => (call === 1 ? frameResponse(7) : stateResponse("live", 7)));
    active = h.poller;
    h.poller.start();
    await tick(40);
    expect(h.urls[1]?.searchParams.get("after")).toBe("7");
    expect(h.latest()).toMatchObject({ status: "live", imageUrl: "blob:frame-1" });
    expect(h.created).toHaveLength(1);
  });

  it.each(["redacted", "paused", "disconnected"] as const)("drops stale pixels when the feed is %s", async (state) => {
    const h = harness(async (_url, call) => (call === 1 ? frameResponse(1) : stateResponse(state, 2)));
    active = h.poller;
    h.poller.start();
    await tick(40);
    expect(h.latest()).toMatchObject({ status: state, imageUrl: null });
    expect(h.revoked).toEqual(["blob:frame-1"]);
  });

  it("reports disconnected with backoff on network failure, then recovers", async () => {
    const h = harness(async (_url, call) => (call <= 2 ? Promise.reject(new TypeError("network")) : frameResponse(3)));
    active = h.poller;
    h.poller.start();
    await tick(5);
    expect(h.latest()?.status).toBe("disconnected");
    await tick(80);
    expect(h.latest()).toMatchObject({ status: "live", sequence: 3 });
  });

  it("reports runs this viewer cannot see as not-found without retrying rapidly", async () => {
    const h = harness(async () => new Response(null, { status: 404 }));
    active = h.poller;
    h.poller.start();
    await tick(50);
    expect(h.latest()?.status).toBe("not-found");
    expect(h.urls).toHaveLength(1);
  });

  it("does not poll while the page is hidden, so the host viewer lease can lapse", async () => {
    const h = harness(async () => frameResponse(1), { hidden: () => true });
    active = h.poller;
    h.poller.start();
    await tick(30);
    expect(h.urls).toHaveLength(0);
  });

  it("aborts the in-flight request and releases the frame on stop", async () => {
    let aborted = false;
    const h = harness(async (_url, call, signal) => {
      if (call === 1) return frameResponse(1);
      return new Promise<Response>((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }),
      );
    });
    h.poller.start();
    await tick(30);
    h.poller.stop();
    await tick(5);
    expect(aborted).toBe(true);
    expect(h.revoked).toEqual(["blob:frame-1"]);
    expect(h.latest()?.imageUrl).toBeNull();
  });
});
