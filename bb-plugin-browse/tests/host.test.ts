import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
const mock = vi.hoisted(() => ({
  events: [] as string[],
  send: vi.fn(),
  close: vi.fn(),
  evaluate: vi.fn(),
}));
vi.mock("../src/driver", () => ({
  BrowserDriver: {
    connect: async () => ({
      execute: async () => '{"success":true,"data":{}}',
      element: async () => '{"success":true,"data":{}}',
      close: async () => {},
    }),
  },
}));
vi.mock("../src/managed", () => ({
  launchManaged: async () => ({ endpoint: "ws://private", process: { exitCode: 0, signalCode: null, once: () => {} }, close: async () => mock.events.push("chrome-close") }),
}));
vi.mock("../src/runtime", () => ({
  ensureRuntime: async () => "/binary",
  installed: async () => true,
  runtimePath: () => "/binary",
}));
vi.mock("../src/process", () => ({
  runProcess: async () => '{"success":true,"data":{}}',
}));
vi.mock("../src/bridge", () => ({
  Bridge: {
    open: async () => ({
      endpoint: "ws://private",
      close: () => mock.events.push("bridge-close"),
    }),
  },
}));
vi.mock("../src/cdp", () => ({
  Cdp: {
    connect: async () => ({
      targetId: "tab",
      send: mock.send,
      evaluate: mock.evaluate,
      configureLiveCast: async () => {}, startLiveCast: async () => {},
      stopLiveCast: async () => {},
      nextLiveFrame: async () => ({
        data: "jpeg",
        width: 1280,
        height: 800,
        seq: 1,
      }),
      onEvent: () => () => {},
      close: () => mock.events.push("cdp-close"),
    }),
  },
}));
import entry from "../host";
it("cancels a nested stroke, releases the pointer before disconnect, and releases worker leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "ab-host-test-"));
  const h = experimental_createHostEntryHarness(entry, {
    experimental_paths: { dataDir: root, tempDir: root },
  });
  mock.events.length = 0;
  mock.send.mockImplementation(async (_method, params) => {
    mock.events.push(params.type);
    return {};
  });
  try {
    const connection = await h.experimental_call("connect", {
      id: "ab-host-test",
      endpoint: "ws://private",
      expiresAt: Date.now() + 60000,
    });
    for (;;) {
      const j = await h.experimental_call("job", { id: connection.id });
      if (j.status !== "running") {
        expect(j.status).toBe("succeeded");
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const j = await h.experimental_call("submit", {
      id: "ab-host-test",
      operation: {
        kind: "sequence",
        steps: [
          {
            kind: "gesture",
            strokes: [Array.from({ length: 100 }, (_, i) => ({ x: i, y: i }))],
            intervalMs: 30,
          },
          { kind: "command", args: ["get", "title"] },
        ],
      },
    });
    expect(j.status).toBe("running");
    await h.experimental_call("cancel", { id: j.id });
    let result;
    for (;;) {
      result = await h.experimental_call("job", { id: j.id });
      if (result.status !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(result.status).toBe("cancelled");
    expect(mock.events.indexOf("mouseReleased")).toBeGreaterThan(
      mock.events.indexOf("mousePressed"),
    );
    expect(mock.events.indexOf("bridge-close")).toBeGreaterThan(
      mock.events.indexOf("mouseReleased"),
    );
    await vi.waitFor(() =>
      expect(h.experimental_getRetainedWorkerLeaseCount()).toBe(0),
    );
    const state = await h.experimental_call("inspect", { id: "ab-host-test" });
    expect(state.status).toBe("released");
  } finally {
    await h.experimental_dispose();
    expect(h.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
});

it("streams native frames and accepts viewer input without extending the desktop lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "browse-native-view-"));
  const h = experimental_createHostEntryHarness(entry, {
    experimental_paths: { dataDir: root, tempDir: root },
  });
  const expiresAt = Date.now() + 60000;
  mock.evaluate.mockImplementation(async (expression: string) =>
    expression === "document.readyState" ? "complete" : "https://example.com",
  );
  mock.send.mockResolvedValue({});
  try {
    let j = await h.experimental_call("connect", {
      id: "ab-native-view",
      mode: "native",
      endpoint: "ws://private",
      expiresAt,
    });
    while (j.status === "running") {
      await new Promise((r) => setTimeout(r, 5));
      j = await h.experimental_call("job", { id: j.id });
    }
    expect(j.status).toBe("succeeded");
    expect(
      await h.experimental_call("frame", { id: "ab-native-view" }),
    ).toMatchObject({ data: "jpeg", width: 1280 });
    expect(
      await h.experimental_call("inspect", { id: "ab-native-view" }),
    ).toMatchObject({ expiresAt });
    const input = await h.experimental_call("input", {
      id: "ab-native-view",
      input: { kind: "text", text: "hello" },
    });
    expect(input.status).toBe("succeeded");
    expect(mock.send).toHaveBeenCalledWith("Input.insertText", {
      text: "hello",
    });
    const reload = await h.experimental_call("input", { id: "ab-native-view", input: { kind: "maintenance", action: "hard-reload" } });
    expect(reload.status).toBe("succeeded");
    expect(mock.send).toHaveBeenCalledWith("Page.reload", { ignoreCache: true });
    const clear = await h.experimental_call("input", { id: "ab-native-view", input: { kind: "maintenance", action: "clear-cookies" } });
    expect(clear.status).toBe("failed");
    expect(mock.send).not.toHaveBeenCalledWith("Network.clearBrowserCookies", {});
    await expect(
      h.experimental_call("credentialPrepare", {
        id: "ab-native-view",
        purpose: "Test expiring lease",
        fields: [
          { selector: "#password", label: "Password", kind: "password" },
        ],
        submitSelector: "button",
      }),
    ).rejects.toThrow("Reconnect an expiring native session");
  } finally {
    await h.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("expires idle managed Chrome despite frame polling, and renews on actual input", async () => {
  const root = await mkdtemp(join(tmpdir(), "browse-idle-"));
  const h = experimental_createHostEntryHarness(entry, { experimental_paths: { dataDir: root, tempDir: root } });
  mock.send.mockResolvedValue({});
  mock.evaluate.mockImplementation(async (expression: string) =>
    expression === "document.readyState" ? "complete" : "https://example.com",
  );
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    let j = await h.experimental_call("connect", { id: "ab-idle-test", mode: "managed", endpoint: "", url: "https://example.com", expiresAt: Date.now() + 900000 });
    while (j.status === "running") { await new Promise<void>(r => setImmediate(r)); j = await h.experimental_call("job", { id: j.id }); }
    expect(j.status).toBe("succeeded");
    const before = await h.experimental_call("inspect", { id: "ab-idle-test" });
    await vi.advanceTimersByTimeAsync(840000);
    await h.experimental_call("frame", { id: "ab-idle-test" });
    expect((await h.experimental_call("inspect", { id: "ab-idle-test" })).expiresAt).toBe(before.expiresAt);
    const kept = await h.experimental_call("keepalive", { id: "ab-idle-test" });
    expect(kept.expiresAt).toBeGreaterThan(before.expiresAt!);
    await vi.advanceTimersByTimeAsync(1000);
    await h.experimental_call("input", { id: "ab-idle-test", input: { kind: "text", text: "x" } });
    expect((await h.experimental_call("inspect", { id: "ab-idle-test" })).expiresAt).toBeGreaterThan(before.expiresAt!);
    await vi.advanceTimersByTimeAsync(899999);
    expect((await h.experimental_call("inspect", { id: "ab-idle-test" })).status).toBe("ready");
    await vi.advanceTimersByTimeAsync(2);
    expect((await h.experimental_call("inspect", { id: "ab-idle-test" })).status).toBe("released");
    expect(mock.events).toContain("chrome-close");
  } finally { vi.useRealTimers(); await h.experimental_dispose(); await rm(root, { recursive: true, force: true }); }
});
