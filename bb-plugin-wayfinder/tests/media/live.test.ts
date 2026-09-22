import { describe, expect, it, vi } from "vitest";

import {
  createLiveFrameHandler,
  LIVE_FRAME_HEADERS,
  LiveCaptureLoop,
  LiveFrameRelay,
  toHostFrame,
  type CapturedImage,
  type HostFrame,
} from "../../src/media/live.js";

const image = (size = 100): CapturedImage => ({ bytes: new Uint8Array(size).fill(7), mimeType: "image/webp", width: 640, height: 360 });
const policy = { enabled: true, maxFps: 12, maxFrameBytes: 1_000 };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("LiveCaptureLoop", () => {
  it("does not capture without a viewer and starts on demand", async () => {
    const capture = vi.fn(async () => image());
    const loop = new LiveCaptureLoop({ capture, policy, isProtected: () => false });
    const controller = new AbortController();
    const running = loop.run(controller.signal);
    await tick(50);
    expect(capture).not.toHaveBeenCalled();
    loop.touchViewer("relay");
    await tick(50);
    expect(capture).toHaveBeenCalled();
    expect(loop.latest(null)?.state).toBe("live");
    controller.abort();
    await running;
    expect(loop.latest(null)?.state).toBe("disconnected");
    expect(loop.latest(null)?.bytes).toBeNull();
  });

  it("stops capturing when viewer leases expire", async () => {
    let now = 0;
    const capture = vi.fn(async () => image());
    const loop = new LiveCaptureLoop({ capture, policy, isProtected: () => false, viewerTtlMs: 1_000, now: () => now });
    loop.touchViewer("relay");
    expect(loop.activeViewerCount()).toBe(1);
    now = 1_000;
    expect(loop.activeViewerCount()).toBe(0);
  });

  it("caps the rate at maxFps with one capture in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const capture = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight -= 1;
      return image();
    });
    const loop = new LiveCaptureLoop({ capture, policy: { ...policy, maxFps: 10 }, isProtected: () => false });
    loop.touchViewer("relay");
    const controller = new AbortController();
    const running = loop.run(controller.signal);
    await tick(420);
    controller.abort();
    await running;
    expect(maxInFlight).toBe(1);
    expect(capture.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(capture.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("drops oversized frames instead of publishing them", async () => {
    const loop = new LiveCaptureLoop({ capture: async () => image(5_000), policy, isProtected: () => false });
    loop.touchViewer("relay");
    const controller = new AbortController();
    const running = loop.run(controller.signal);
    await tick(30);
    controller.abort();
    await running;
    expect(loop.stats.droppedOversize).toBeGreaterThan(0);
    expect(loop.stats.captured).toBe(0);
  });

  it("replaces live pixels with a byte-less redacted frame during protected input", async () => {
    let protectedInput = false;
    const capture = vi.fn(async () => image());
    const loop = new LiveCaptureLoop({ capture, policy, isProtected: () => protectedInput });
    loop.touchViewer("relay");
    const controller = new AbortController();
    const running = loop.run(controller.signal);
    await tick(30);
    expect(loop.latest(null)?.state).toBe("live");
    protectedInput = true;
    const callsBefore = capture.mock.calls.length;
    await tick(200);
    expect(loop.latest(null)).toMatchObject({ state: "redacted", bytes: null });
    expect(capture.mock.calls.length).toBe(callsBefore);
    expect(toHostFrame(loop.latest(null)!).bytesBase64).toBe("");
    controller.abort();
    await running;
  });

  it("publishes paused when preview is disabled by policy and never captures", async () => {
    const capture = vi.fn(async () => image());
    const loop = new LiveCaptureLoop({ capture, policy: { ...policy, enabled: false }, isProtected: () => false });
    loop.touchViewer("relay");
    const controller = new AbortController();
    const running = loop.run(controller.signal);
    await tick(10);
    expect(loop.latest(null)?.state).toBe("paused");
    controller.abort();
    await running;
    expect(capture).not.toHaveBeenCalled();
  });
});

const hostFrame = (sequence: number, state: HostFrame["state"] = "live", withPixels = state === "live"): HostFrame => ({
  sequence,
  capturedAt: 1_000,
  mimeType: "image/webp",
  width: 640,
  height: 360,
  bytesBase64: withPixels ? Buffer.from("frame").toString("base64") : "",
  state,
});

describe("LiveFrameRelay", () => {
  it("fans many concurrent viewers into one host fetch", async () => {
    let release!: () => void;
    const fetchLatest = vi.fn(
      () =>
        new Promise<HostFrame>((resolve) => {
          release = () => resolve(hostFrame(1));
        }),
    );
    const relay = new LiveFrameRelay({ fetchLatest });
    const viewers = Array.from({ length: 25 }, () => relay.latest("run_a"));
    release();
    const frames = await Promise.all(viewers);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(new Set(frames.map((frame) => frame?.sequence))).toEqual(new Set([1]));
  });

  it("marks the frame disconnected and preserves its last safe pixels when the host fetch fails", async () => {
    let now = 0;
    const fetchLatest = vi.fn<(...args: unknown[]) => Promise<HostFrame | null>>().mockResolvedValueOnce(hostFrame(1)).mockRejectedValueOnce(new Error("host gone"));
    const relay = new LiveFrameRelay({ fetchLatest, minFetchIntervalMs: 100, now: () => now });
    const live = await relay.latest("run_a");
    expect(live?.state).toBe("live");
    now = 200;
    expect(await relay.latest("run_a")).toMatchObject({ state: "disconnected", bytes: live?.bytes });
  });
});

describe("live frame HTTP handler", () => {
  const relayWith = (frame: HostFrame | null) => new LiveFrameRelay({ fetchLatest: async () => frame });
  const get = (handler: (request: Request) => Promise<Response>, query: string) => handler(new Request(`http://bb.local/x?${query}`));

  it("serves the private frame with age headers and no caching", async () => {
    const handler = createLiveFrameHandler({ relay: relayWith(hostFrame(4)), authorize: () => true, now: () => 1_250 });
    const response = await get(handler, "runId=run_a");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get(LIVE_FRAME_HEADERS.sequence)).toBe("4");
    expect(response.headers.get(LIVE_FRAME_HEADERS.ageMs)).toBe("250");
    expect(await response.text()).toBe("frame");
    const unchanged = await get(handler, "runId=run_a&after=4");
    expect(unchanged.status).toBe(204);
    expect(unchanged.headers.get(LIVE_FRAME_HEADERS.state)).toBe("live");
  });

  it("never serves pixels for redacted, paused, or byte-less disconnected states", async () => {
    for (const state of ["redacted", "paused", "disconnected"] as const) {
      const handler = createLiveFrameHandler({ relay: relayWith(hostFrame(2, state)), authorize: () => true });
      const response = await get(handler, "runId=run_a");
      expect(response.status).toBe(204);
      expect(response.headers.get(LIVE_FRAME_HEADERS.state)).toBe(state);
    }
  });

  it("serves retained sanitized pixels while reporting a disconnected feed", async () => {
    const handler = createLiveFrameHandler({ relay: relayWith(hostFrame(2, "disconnected", true)), authorize: () => true });
    const response = await get(handler, "runId=run_a");
    expect(response.status).toBe(200);
    expect(response.headers.get(LIVE_FRAME_HEADERS.state)).toBe("disconnected");
    expect(await response.text()).toBe("frame");
  });

  it("refuses share tokens, invalid IDs, and unauthorized runs", async () => {
    const authorize = vi.fn(() => false);
    const handler = createLiveFrameHandler({ relay: relayWith(hostFrame(1)), authorize });
    expect((await get(handler, "runId=run_a&token=abc")).status).toBe(400);
    expect((await get(handler, "runId=..%2Fx")).status).toBe(400);
    expect((await get(handler, "runId=run_a&after=-1")).status).toBe(400);
    expect((await get(handler, "runId=run_other")).status).toBe(404);
    expect(authorize).toHaveBeenCalledWith("run_other");
  });
});
