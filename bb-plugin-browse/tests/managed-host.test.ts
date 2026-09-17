import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
const mock = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  send: vi.fn(async (_method: string, _params: any) => ({})),
  evaluate: vi.fn(async () => "https://example.com"),
  configureLiveCast: async () => {}, startLiveCast: vi.fn(async () => {}),
  stopLiveCast: vi.fn(async () => {}),
  refreshLiveCast: vi.fn(async () => {}),
  nextLiveFrame: vi.fn(async () => ({
    data: "jpeg",
    width: 1280,
    height: 800,
    seq: 1,
  })),
  events: [] as string[],
  cdpListeners: [] as Array<(method: string, params: any) => void>,
  commands: [] as string[][],
  driverClose: vi.fn(async () => {}),
  videoInput: {
    isClosed: false,
    runInput: vi.fn(async () => ({})),
    resetInput: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    read: vi.fn(async () => []),
    timing: vi.fn(() => ({ queueMs: 0, packetGapMs: 0 })),
    controlBusy: false,
    controlHeld: false,
    controlOwner: undefined as string | undefined,
  },
}));
vi.mock("../src/driver", () => ({
  BrowserDriver: {
    connect: async () => ({
      execute: async () => '{"success":true,"data":{}}',
      element: async () => '{"success":true,"data":{}}',
      close: mock.driverClose,
    }),
  },
}));
vi.mock("../src/runtime", () => ({
  ensureRuntime: async () => "/binary",
  installed: async () => true,
  runtimePath: () => "/binary",
}));
vi.mock("../src/managed", () => ({
  managedEnv: () => ({}),
  diagnostics: async () => ({}),
  installManaged: async () => {},
  launchManaged: async () => ({
    endpoint: "ws://owned",
    profile: "/owned/profile",
    process: Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null }),
    displayEnv: { DISPLAY: ":99" },
    close: mock.close,
  }),
}));
vi.mock("../src/runtime-cleanup", () => ({
  prepareManagedRuntime: async () => {},
}));
vi.mock("../src/selkies", () => ({
  SelkiesStream: { start: async () => mock.videoInput },
}));
vi.mock("../src/process", () => ({
  runProcess: async (_binary: string, args: string[]) => {
    mock.commands.push(args);
    return '{"success":true,"data":{}}';
  },
}));
vi.mock("../src/cdp", () => ({
  Cdp: {
    connect: async () => ({
      targetId: "managed",
      send: mock.send,
      evaluate: mock.evaluate,
      configureLiveCast: async () => {}, startLiveCast: mock.startLiveCast,
      stopLiveCast: mock.stopLiveCast,
      refreshLiveCast: mock.refreshLiveCast,
      nextLiveFrame: mock.nextLiveFrame,
      onEvent: (listener: (method: string, params: any) => void) => {
        mock.cdpListeners.push(listener);
        return () => {
          const index = mock.cdpListeners.indexOf(listener);
          if (index >= 0) mock.cdpListeners.splice(index, 1);
        };
      },
      close: () => mock.events.push("cdp-close"),
    }),
  },
}));
vi.mock("../src/bridge", () => ({
  Bridge: {
    open: () => {
      throw Error("Managed mode must not use native bridge");
    },
  },
}));
import entry from "../host";
it("owns managed Fortress, blocks viewer input during a job, and stops it after pointer cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "browse-managed-host-")),
    h = experimental_createHostEntryHarness(entry, {
      experimental_paths: { dataDir: root, tempDir: root },
    });
  async function wait(j: any) {
    while (j.status === "running") {
      await new Promise((r) => setTimeout(r, 5));
      j = await h.experimental_call("job", { id: j.id });
    }
    return j;
  }
  mock.close.mockImplementation(async () => {
    mock.events.push("browser-close");
  });
  mock.send.mockImplementation(async (method: any, params: any) => {
    if (params.type) mock.events.push(params.type);
    if (method === "Target.getTargets")
      return {
        targetInfos: [
          { targetId: "managed", type: "page", url: "https://example.com" },
        ],
      };
    if (method === "Browser.getWindowForTarget")
      return { windowId: params.targetId === "managed" ? 1 : 2 };
    return {};
  });
  try {
    const j = await h.experimental_call("connect", {
      id: "ab-managed-host",
      mode: "managed",
      video: true,
      expiresAt: Date.now() + 60000,
    });
    expect((await wait(j)).status).toBe("succeeded");
    const responsive = await h.experimental_call("input", {
      id: "ab-managed-host",
      input: { kind: "viewport", width: 390, height: 844, mobile: true },
    });
    expect((await wait(responsive)).status).toBe("succeeded");
    expect(mock.send).toHaveBeenCalledWith(
      "Emulation.setDeviceMetricsOverride",
      expect.objectContaining({
        width: 390,
        height: 844,
        mobile: true,
        screenOrientation: { type: "portraitPrimary", angle: 0 },
      }),
    );
    expect(mock.refreshLiveCast).toHaveBeenCalledOnce();
    expect(await h.experimental_call("inspect", { id: "ab-managed-host" })).toMatchObject({
      viewport: { width: 390, height: 844, mobile: true },
    });
    await h.experimental_call("videoStart", {
      id: "ab-managed-host",
      clientId: "viewer",
      binary: false,
    });
    let finishVideoStop!: () => void;
    mock.videoInput.stop.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishVideoStop = resolve; }),
    );
    const stoppingVideo = h.experimental_call("videoStop", {
      id: "ab-managed-host",
      clientId: "viewer",
    });
    const restartingVideo = h.experimental_call("videoStart", {
      id: "ab-managed-host",
      clientId: "viewer-restart",
      binary: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    finishVideoStop();
    await stoppingVideo;
    await expect(restartingVideo).resolves.toMatchObject({ ok: true });
    await h.experimental_call("videoStop", {
      id: "ab-managed-host",
      clientId: "viewer-restart",
    });
    await h.experimental_call("videoStart", {
      id: "ab-managed-host",
      clientId: "viewer-reconnected",
      binary: false,
    });
    for (const listener of mock.cdpListeners)
      listener("Page.javascriptDialogOpening", {
        type: "prompt",
        message: "Your name?",
        defaultPrompt: "Ada",
      });
    const evaluationsBeforeDialogInspect = mock.evaluate.mock.calls.length;
    expect(await h.experimental_call("inspect", { id: "ab-managed-host" })).toMatchObject({
      dialog: { type: "prompt", message: "Your name?", defaultPrompt: "Ada" },
    });
    expect(mock.evaluate).toHaveBeenCalledTimes(evaluationsBeforeDialogInspect);
    mock.videoInput.controlHeld = true;
    mock.videoInput.controlBusy = true;
    mock.videoInput.controlOwner = "stale-viewer";
    mock.videoInput.resetInput.mockImplementationOnce(async () => {
      mock.videoInput.controlHeld = false;
    });
    const dialog = await h.experimental_call("input", {
      id: "ab-managed-host",
      clientId: "viewer-reconnected",
      input: { kind: "dialog", accept: true, promptText: "Grace" },
    });
    expect((await wait(dialog)).status).toBe("succeeded");
    expect(mock.videoInput.resetInput).toHaveBeenCalledWith();
    mock.videoInput.controlBusy = false;
    mock.videoInput.controlOwner = undefined;
    expect(mock.send).toHaveBeenCalledWith("Page.handleJavaScriptDialog", {
      accept: true,
      promptText: "Grace",
    });
    mock.videoInput.runInput.mockClear();
    await h.experimental_call("direct", {
      id: "ab-managed-host",
      clientId: "viewer",
      events: [{
        kind: "pointer",
        type: "down",
        x: 780,
        y: 420,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      }, {
        kind: "pointer",
        type: "up",
        x: 780,
        y: 420,
        button: "left",
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      }],
    });
    expect(mock.videoInput.runInput).toHaveBeenCalledWith(
      "viewer",
      expect.arrayContaining([
        expect.objectContaining({ kind: "pointer", type: "down" }),
        expect.objectContaining({ kind: "pointer", type: "up" }),
      ]),
    );
    mock.videoInput.isClosed = true;
    mock.send.mockClear();
    await h.experimental_call("direct", {
      id: "ab-managed-host",
      clientId: "viewer",
      events: [{
        kind: "pointer",
        type: "down",
        x: 30,
        y: 40,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      }, {
        kind: "pointer",
        type: "up",
        x: 30,
        y: 40,
        button: "left",
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      }],
    });
    expect(mock.send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 30, y: 40 }),
    );
    mock.videoInput.isClosed = false;
    const running = await h.experimental_call("submit", {
      id: "ab-managed-host",
      operation: {
        kind: "sequence",
        steps: [
          {
            kind: "gesture",
            strokes: [Array.from({ length: 100 }, (_, i) => ({ x: i, y: 10 }))],
            intervalMs: 30,
          },
        ],
      },
    });
    await expect(
      h.experimental_call("input", {
        id: "ab-managed-host",
        input: { kind: "text", text: "conflict" },
      }),
    ).rejects.toThrow("busy");
    await h.experimental_call("cancel", { id: running.id });
    expect((await wait(running)).status).toBe("cancelled");
    expect(mock.events.indexOf("browser-close")).toBeGreaterThan(
      mock.events.indexOf("mouseReleased"),
    );
    expect(mock.close).toHaveBeenCalled();
  } finally {
    await h.experimental_dispose();
    expect(h.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
});

it("cancelling a completed job is harmless, and concurrent releases dispose the browser once", async () => {
  const root = await mkdtemp(join(tmpdir(), "browse-completed-")),
    h = experimental_createHostEntryHarness(entry, {
      experimental_paths: { dataDir: root, tempDir: root },
    });
  mock.close.mockClear();
  mock.events.length = 0;
  try {
    let j = await h.experimental_call("connect", {
      id: "ab-completed-cancel",
      mode: "managed",
      expiresAt: Date.now() + 60000,
    });
    while (j.status === "running") {
      await new Promise((r) => setTimeout(r, 5));
      j = await h.experimental_call("job", { id: j.id });
    }
    expect(j.status).toBe("succeeded");
    await h.experimental_call("cancel", { id: j.id });
    expect(mock.close).not.toHaveBeenCalled();
    expect(
      (await h.experimental_call("inspect", { id: "ab-completed-cancel" }))
        .status,
    ).toBe("ready");
    await Promise.all(
      Array.from({ length: 5 }, () =>
        h.experimental_call("release", { id: "ab-completed-cancel" }),
      ),
    );
    expect(mock.driverClose).toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
    expect(h.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    expect(
      (await h.experimental_call("inspect", { id: "ab-completed-cancel" }))
        .status,
    ).toBe("released");
  } finally {
    await h.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("reserves a session ID before asynchronous filesystem work", async () => {
  const root = await mkdtemp(join(tmpdir(), "browse-reserve-"));
  const h = experimental_createHostEntryHarness(entry, {
    experimental_paths: { dataDir: root, tempDir: root },
  });
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        h.experimental_call("connect", {
          id: "ab-same-id",
          mode: "managed",
          expiresAt: Date.now() + 60000,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const result = results.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<any>;
    let job = result.value;
    while (job.status === "running") {
      await new Promise((r) => setTimeout(r, 5));
      job = await h.experimental_call("job", { id: job.id });
    }
    expect(job.status).toBe("succeeded");
    await h.experimental_call("release", { id: "ab-same-id" });
    expect(h.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  } finally {
    await h.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses a resized viewport for live frames and scroll coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "browse-viewport-"));
  const h = experimental_createHostEntryHarness(entry, {
    experimental_paths: { dataDir: root, tempDir: root },
  });
  mock.nextLiveFrame.mockResolvedValue({
    data: "jpeg",
    width: 390,
    height: 600,
    seq: 1,
  });
  mock.send.mockImplementation(async (method: string) =>
    method === "Page.getLayoutMetrics"
      ? {
          cssVisualViewport: {
            clientWidth: 390,
            clientHeight: 600,
            pageX: 0,
            pageY: 500,
          },
        }
      : {},
  );
  try {
    let j = await h.experimental_call("connect", {
      id: "ab-viewport",
      mode: "managed",
      expiresAt: Date.now() + 60000,
    });
    while (j.status === "running") {
      await new Promise((r) => setTimeout(r, 5));
      j = await h.experimental_call("job", { id: j.id });
    }
    expect(j.status).toBe("succeeded");
    mock.evaluate.mockResolvedValueOnce("https://example.com").mockResolvedValueOnce(true as any);
    expect(
      await h.experimental_call("frame", { id: "ab-viewport" }),
    ).toMatchObject({ data: "jpeg", width: 390, height: 600, seq: 1, loading: true });
    await new Promise(r=>setTimeout(r,110));
    mock.evaluate.mockResolvedValueOnce("https://example.com").mockResolvedValueOnce(false as any);
    expect(await h.experimental_call("frame", { id: "ab-viewport" })).toMatchObject({ loading: false });
    expect(mock.startLiveCast).toHaveBeenCalled();
    expect(mock.nextLiveFrame).toHaveBeenCalled();
    await h.experimental_call("input", {
      id: "ab-viewport",
      input: { kind: "scroll", deltaY: 300 },
    });
    expect(mock.send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseWheel", x: 195, y: 300 }),
    );
  } finally {
    await h.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("closing an active job completes without the shutdown fallback delay", async () => {
  const root = await mkdtemp(join(tmpdir(), "browse-close-active-"));
  const h = experimental_createHostEntryHarness(entry, {
    experimental_paths: { dataDir: root, tempDir: root },
  });
  mock.send.mockImplementation(async () => ({}));
  try {
    let j = await h.experimental_call("connect", {
      id: "ab-close-active",
      mode: "managed",
      expiresAt: Date.now() + 60000,
    });
    while (j.status === "running") {
      await new Promise((r) => setTimeout(r, 5));
      j = await h.experimental_call("job", { id: j.id });
    }
    expect(j.status).toBe("succeeded");
    j = await h.experimental_call("submit", {
      id: "ab-close-active",
      operation: {
        kind: "sequence",
        steps: [
          {
            kind: "gesture",
            strokes: [Array.from({ length: 100 }, (_, i) => ({ x: i, y: 20 }))],
            intervalMs: 30,
          },
        ],
      },
    });
    expect(j.status).toBe("running");
    const started = performance.now();
    await h.experimental_call("release", { id: "ab-close-active" });
    expect(performance.now() - started).toBeLessThan(1200);
    expect((await h.experimental_call("job", { id: j.id })).status).toBe(
      "cancelled",
    );
    expect(h.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  } finally {
    await h.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  }
});
