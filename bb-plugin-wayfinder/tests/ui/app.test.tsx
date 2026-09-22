// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { UiRpcContract } from "../../components/rpc.js";
import { artifactRecordSchema, type ArtifactRecord } from "../../src/contracts/artifact.js";

// Everything that touches the SDK app runtime loads after the test runtime is installed.
const app = await loadPluginApp(() => import("../../app.js"));
const { selectedRunFromParams } = await import("../../components/computer-panel.js");
const directive = app.messageDirectives.find((registration) => registration.id === "wayfinder-artifact")!;
const panel = app.threadPanelActions.find((registration) => registration.id === "computer")!;
const settingsSection = app.settingsSections.find((registration) => registration.id === "wayfinder-settings")!;

afterEach(cleanup);

const SHA = "a".repeat(64);

function artifact(overrides: { mimeType?: string; filename?: string; threadId?: string; sanitized?: boolean } = {}): ArtifactRecord {
  const threadId = overrides.threadId ?? "thr_a";
  const mimeType = overrides.mimeType ?? "image/png";
  return artifactRecordSchema.parse({
    artifactId: "art_1",
    runId: "run_a",
    threadId,
    projectId: null,
    media: {
      mediaId: "art_1",
      runId: "run_a",
      threadId,
      kind: mimeType.startsWith("video/") ? "video" : mimeType.startsWith("image/") ? "image" : "report",
      filename: overrides.filename ?? "checkout.png",
      mimeType,
      sizeBytes: 2_048,
      sha256: SHA,
      createdAt: 1,
      width: 1280,
      height: 720,
      durationMs: null,
      captureStartedAt: null,
      captureEndedAt: null,
      redacted: false,
    },
    storage: { kind: "host-private", relativePath: "blobs/run_a/art_1.png", immutableSha256: SHA },
    sanitized: overrides.sanitized ?? true,
    retentionExpiresAt: Date.now() + 60_000,
  });
}

const message = (threadId: string) => ({ id: "msg_1", threadId, turnId: null, projectId: null });
const disabledShare = { external: { state: "disabled" as const, reason: "No verified HTTPS export origin" }, shares: [] };

function renderDirective(attributes: Record<string, string>, threadId: string, rpc: Record<string, (input: never) => unknown>) {
  return renderSlot(
    directive,
    { attributes, source: "::wayfinder-artifact", message: message(threadId), openWorkspaceFile: null },
    { rpc: rpc as never },
  );
}

describe("app registration", () => {
  it("registers Computer only as a right thread-panel tab, plus the inline artifact directive", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(panel).toMatchObject({ title: "Open computer", icon: "Laptop", layout: "flush" });
    expect(directive).toBeDefined();
  });

  it("opens a tab titled Computer from the Open computer action", async () => {
    const openPanel = vi.fn(() => true);
    await panel.run?.({ threadId: "thr_a", openPanel });
    expect(openPanel).toHaveBeenCalledWith({ title: "Computer" });
  });

  it("parses only well-formed run tab parameters", () => {
    expect(selectedRunFromParams({ runId: "run_a" })).toBe("run_a");
    expect(selectedRunFromParams({ runId: "../etc" })).toBeNull();
    expect(selectedRunFromParams({ runId: "a/b" })).toBeNull();
    expect(selectedRunFromParams(null)).toBeNull();
  });
});

describe("inline artifact card", () => {
  it("looks artifacts up in the message's own thread and renders a thread-scoped image", async () => {
    const slot = renderDirective({ id: "art_1" }, "thr_a", {
      "artifacts.get": () => artifact(),
      "artifacts.shareStatus": () => disabledShare,
    });
    const image = (await slot.findByRole("img", { name: "checkout.png" })) as HTMLImageElement;
    const src = new URL(image.src);
    expect(src.pathname).toBe("/api/v1/plugins/wayfinder/http/v1/artifacts/inline");
    expect(src.searchParams.get("threadId")).toBe("thr_a");
    expect(slot.inspection.rpcCalls[0]).toEqual({ method: "artifacts.get", input: { threadId: "thr_a", artifactId: "art_1" } });
    expect(slot.getByText(/image\/png · 2\.0 KB · 1280×720/u)).toBeDefined();
  });

  it("shows another thread's artifact as unavailable instead of rendering it", async () => {
    const slot = renderDirective({ id: "art_1" }, "thr_b", {
      "artifacts.get": (input: { threadId: string }) => {
        if (input.threadId !== "thr_a") throw new Error("Artifact not found");
        return artifact();
      },
    });
    await slot.findByText(/Artifact unavailable: Artifact not found/u);
    expect(slot.queryByRole("img")).toBeNull();
    expect(slot.inspection.rpcCalls[0]?.input).toMatchObject({ threadId: "thr_b" });
  });

  it("rejects malformed or path-shaped IDs without calling the server", async () => {
    for (const id of ["../../etc/passwd", "", "a b"]) {
      const slot = renderDirective({ id }, "thr_a", {});
      await slot.findByText("Invalid Wayfinder artifact reference.");
      expect(slot.inspection.rpcCalls).toEqual([]);
      slot.lifecycle.unmount();
    }
  });

  it("never renders HTML reports inline: no iframe, no image, download only", async () => {
    const slot = renderDirective({ id: "art_1" }, "thr_a", {
      "artifacts.get": () => artifact({ mimeType: "text/html", filename: "<img src=x onerror=alert(1)>.html" }),
      "artifacts.shareStatus": () => disabledShare,
    });
    await slot.findByText(/Download to view/u);
    expect(slot.container.querySelector("iframe, img, video, script, object, embed")).toBeNull();
    const download = slot.getByRole("link", { name: "Download" }) as HTMLAnchorElement;
    expect(new URL(download.href).pathname).toBe("/api/v1/plugins/wayfinder/http/v1/artifacts/download");
    // The hostile filename is text, not markup.
    expect(slot.getByText("<img src=x onerror=alert(1)>.html")).toBeDefined();
  });

  it("streams videos from the range-capable route instead of embedding them", async () => {
    const slot = renderDirective({ id: "art_1" }, "thr_a", {
      "artifacts.get": () => artifact({ mimeType: "video/mp4", filename: "flow.mp4" }),
      "artifacts.shareStatus": () => disabledShare,
    });
    await slot.findByText("flow.mp4");
    const video = slot.container.querySelector("video")!;
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.getAttribute("src")).toMatch(/^\/api\/v1\/plugins\/wayfinder\/http\/v1\/artifacts\/inline\?/u);
  });

  it("keeps Share disabled with the exact prerequisite when external sharing is not configured", async () => {
    const slot = renderDirective({ id: "art_1" }, "thr_a", {
      "artifacts.get": () => artifact(),
      "artifacts.shareStatus": () => disabledShare,
    });
    const share = await slot.findByRole("button", { name: "Share" });
    await waitFor(() => expect(share.getAttribute("title")).toBe("External sharing unavailable: No verified HTTPS export origin"));
    expect((share as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps Share disabled for unsanitized artifacts even when sharing is ready", async () => {
    const slot = renderDirective({ id: "art_1" }, "thr_a", {
      "artifacts.get": () => artifact({ sanitized: false }),
      "artifacts.shareStatus": () => ({ external: { state: "ready" }, shares: [] }),
    });
    const share = await slot.findByRole("button", { name: "Share" });
    await waitFor(() => expect(share.getAttribute("title")).toBe("Only sanitized artifacts can be shared"));
    expect((share as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates a thread-scoped expiring link only after the user opens Share and confirms", async () => {
    const share = {
      shareId: "shr_1",
      artifactIds: ["art_1"],
      runId: "run_a",
      threadId: "thr_a",
      createdByUserId: "usr_1",
      createdAt: 1,
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      state: "active",
      audience: "anyone-with-link",
      manifestSha256: SHA,
    };
    const slot = renderDirective({ id: "art_1" }, "thr_a", {
      "artifacts.get": () => artifact(),
      "artifacts.shareStatus": () => ({ external: { state: "ready" }, shares: [] }),
      "artifacts.createShareScoped": () => ({ share, url: "https://share.example/x?share=shr_1&token=t" }),
      "artifacts.revokeShareScoped": () => ({ ...share, state: "revoked", revokedAt: 2 }),
    });
    const button = await slot.findByRole("button", { name: "Share" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(slot.inspection.rpcCalls.map((call) => call.method)).not.toContain("artifacts.createShareScoped");
    fireEvent.click(button);
    fireEvent.change(slot.getByLabelText("Expires after"), { target: { value: "3600" } });
    fireEvent.click(slot.getByRole("button", { name: "Create share link" }));
    await slot.findByDisplayValue("https://share.example/x?share=shr_1&token=t");
    expect(slot.inspection.rpcCalls.find((call) => call.method === "artifacts.createShareScoped")?.input).toEqual({
      threadId: "thr_a",
      runId: "run_a",
      artifactIds: ["art_1"],
      expiresInSeconds: 3_600,
      audience: "anyone-with-link",
    });
    fireEvent.click(slot.getByRole("button", { name: "Revoke" }));
    await slot.findByText(/Link revoked/u);
    expect((slot.getByRole("button", { name: "Copy share link" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the manual-copy fallback when the clipboard is unavailable", async () => {
    const slot = renderDirective({ id: "art_1" }, "thr_a", {
      "artifacts.get": () => artifact({ mimeType: "video/mp4", filename: "flow.mp4" }),
      "artifacts.shareStatus": () => disabledShare,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Copy link" }));
    const manual = (await slot.findByLabelText("Private artifact link")) as HTMLInputElement;
    expect(manual.value).toMatch(/\/api\/v1\/plugins\/wayfinder\/http\/v1\/artifacts\/inline\?artifactId=art_1&threadId=thr_a$/u);
    expect(slot.getByText(/copy it manually/u)).toBeDefined();
  });
});

describe("Computer panel", () => {
  it("shows only a centered spinner while settings load", () => {
    const slot = renderSlot(panel, { threadId: "thr_a", params: null }, {
      rpc: { "settings.get": () => new Promise(() => {}) } as never,
    });
    const loading = slot.getByRole("status", { name: "Loading computer" });
    expect(loading.className).toContain("h-full");
    expect(loading.className).toContain("items-center");
    expect(loading.className).toContain("justify-center");
    expect(loading.textContent).toBe("");
    expect(loading.querySelector(".animate-spin")).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows setup required instead of a fake view when no host is selected", async () => {
    const slot = renderSlot(panel, { threadId: "thr_a", params: null }, { rpc: {} });
    await slot.findByRole("heading", { name: "Setup required" });
    const notice = slot.getByRole("status");
    expect(notice.className).toContain("h-full");
    expect(notice.className).toContain("items-center");
    expect(notice.className).toContain("justify-center");
    expect(notice.querySelector("button")).toBeNull();
    expect(notice.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(slot.inspection.rpcCalls).toEqual(expect.arrayContaining([
      { method: "settings.hostForThread", input: { threadId: "thr_a" } },
      { method: "settings.get", input: {} },
    ]));
  });

  it("keeps the Computer panel viewport-first with compact status overlays", async () => {
    const slot = renderSlot<PluginThreadPanelProps, UiRpcContract>(
      panel,
      { threadId: "thr_a", params: { runId: "run_old" } },
      {
        rpc: {
          "settings.hostForThread": () => ({ hostId: "host_thread", source: "thread" }),
          "settings.get": () =>
            ({
              selectedHostId: "host_1",
              provider: "openrouter",
              model: "openai/test",
              keyStatus: "unknown",
              lastTest: null,
            }) as never,
          "computer.snapshot": () =>
            ({
              hostId: "host_thread",
              readiness: "setup-required",
              readinessMessage: "Fortress browser lease unavailable",
              activeRun: null,
              queue: [{ runId: "run_q", threadId: "thr_q", position: 1, enqueuedAt: 1 }],
              selectedRun: null,
              connectionState: "connected",
              frameSequence: null,
              frameCapturedAt: null,
              sampledAt: 10,
            }) as never,
          "computer.preview": () => ({ frame: { base64: "YWJj", mimeType: "image/png", width: 1280, height: 720, capturedAt: Date.now() }, state: "ready", message: null }),
        } as never,
      },
    );
    await slot.findByRole("img", { name: "Live view of the controlled desktop" });
    expect(slot.getByText("Connected")).toBeDefined();
    expect(slot.getByText("1 queued")).toBeDefined();
    expect(slot.getByText("Selected run is not controlling the computer.")).toBeDefined();
    expect(slot.queryByText("Current controller")).toBeNull();
    expect(slot.queryByText("Queue (1)")).toBeNull();
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "computer.snapshot", input: { hostId: "host_thread", selectedRunId: "run_old" } });
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("shows the whole desktop rather than a browser-only or idle view", async () => {
    const slot = renderSlot<PluginThreadPanelProps, UiRpcContract>(panel, { threadId: "thr_a", params: null }, {
      rpc: {
        "settings.hostForThread": () => ({ hostId: "host_mac", source: "thread" }),
        "settings.get": () => ({ selectedHostId: null, provider: "openrouter", model: "jev", keyStatus: "configured", lastTest: null }),
        "settings.hosts": () => [{ hostId: "host_mac", name: "Studio Mac", status: "connected", phase: "active", os: "darwin", arch: "arm64", browserState: "ready", desktopState: "ready", providerState: "ready" }],
        "computer.snapshot": () => ({ hostId: "host_mac", readiness: "ready", readinessMessage: null, activeRun: null, queue: [], selectedRun: null, connectionState: "connected", frameSequence: null, frameCapturedAt: null, sampledAt: Date.now() }),
        "computer.preview": () => ({ frame: { base64: "YWJj", mimeType: "image/png", width: 1280, height: 800, capturedAt: Date.now() }, state: "ready", message: null }),
      } as never,
    });
    const image = await slot.findByRole("img", { name: "Live view of the controlled desktop" }) as HTMLImageElement;
    expect(image.src).toBe("data:image/png;base64,YWJj");
    expect(slot.queryByText("Computer is idle")).toBeNull();
    expect(slot.getByLabelText("Computer host").textContent).toContain("Studio Mac");
    slot.lifecycle.unmount();
  });

  it("takes human control and gives it back to the agent when the window loses focus", async () => {
    const slot = renderSlot<PluginThreadPanelProps, UiRpcContract>(panel, { threadId: "thr_a", params: null }, {
      rpc: {
        "settings.hostForThread": () => ({ hostId: "host_thread", source: "thread" }),
        "settings.get": () => ({ selectedHostId: null, provider: "openrouter", model: "jev", keyStatus: "configured", lastTest: null }),
        "settings.hosts": () => [{ hostId: "host_thread", name: "Studio Mac", status: "connected", phase: "active", os: "darwin", arch: "arm64", browserState: "ready", desktopState: "ready", providerState: "ready" }],
        "computer.snapshot": () => ({
          hostId: "host_thread", readiness: "ready", readinessMessage: null,
          activeRun: { runId: "run_live", state: "running", route: { goal: "Check the storefront" }, activeController: true },
          queue: [], selectedRun: null, connectionState: "connected", frameSequence: 1, frameCapturedAt: Date.now(), sampledAt: Date.now(),
        }),
        "computer.preview": () => ({ frame: { base64: "YWJj", mimeType: "image/png", width: 1280, height: 720, capturedAt: Date.now() }, state: "ready", message: null }),
        "computer.control.acquire": () => ({ state: "human" }),
        "computer.control.release": () => ({ released: true }),
        "computer.control.input": () => ({ accepted: true }),
      } as never,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText("You’re controlling");
    expect(slot.getByLabelText("Computer host").textContent).toContain("Studio Mac");
    const desktop = slot.getByLabelText("Live computer; click, type, paste, or scroll") as HTMLImageElement;
    Object.defineProperty(desktop, "naturalWidth", { value: 1280 });
    Object.defineProperty(desktop, "naturalHeight", { value: 720 });
    desktop.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
    fireEvent.click(desktop, { clientX: 320, clientY: 180 });
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "computer.control.input", input: { hostId: "host_thread", runId: "run_live", clientId: expect.any(String), input: { kind: "click", x: 640, y: 360, button: "left" } } }));
    window.dispatchEvent(new Event("blur"));
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "computer.control.release")).toBe(true));
    expect(slot.queryByText("You’re controlling")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("Settings section", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a host dropdown from real enrolled hosts, disables disconnected entries, and never shows a raw hostId text field", async () => {
    const slot = renderSlot(
      settingsSection,
      {},
      {
        rpc: {
          "settings.hosts": () =>
            [
              { hostId: "host_a", name: "Shared computer", status: "connected", phase: "active", os: "linux", arch: "x64", browserState: "ready", desktopState: "ready", providerState: "ready" },
              { hostId: "host_b", name: "Old laptop", status: "disconnected", phase: "suspended", os: null, arch: null, browserState: null, desktopState: null, providerState: null },
            ] as never,
          "settings.get": () =>
            ({ selectedHostId: "host_a", provider: "jev", model: "jev-latest", keyStatus: "missing", lastTest: null }) as never,
        } as never,
      },
    );
    const select = (await slot.findByLabelText("Computer host")) as HTMLSelectElement;
    expect(select.value).toBe("host_a");
    const options = Array.from(select.options).map((option) => ({ value: option.value, disabled: option.disabled }));
    expect(options).toContainEqual({ value: "host_b", disabled: true });
    expect(slot.queryByLabelText(/host id/iu)).toBeNull();
    expect(slot.getByLabelText("Model").textContent).toBe("Jev");
    expect(slot.queryByPlaceholderText("e.g. openai/gpt-5")).toBeNull();
    expect(slot.getByLabelText("Provider")).toBeDefined();
    expect(slot.queryByText(/configured/iu)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("renders Jev as the fixed model and exposes one form-level Save action", async () => {
    const slot = renderSlot(settingsSection, {}, {
      rpc: {
        "settings.hosts": () => [{ hostId: "host_a", name: "Shared computer", status: "connected", phase: "active", os: "linux", arch: "x64", browserState: "ready", desktopState: "ready", providerState: "ready" }],
        "settings.get": () => ({ selectedHostId: "host_a", provider: "jev", model: "jev-latest", keyStatus: "missing", lastTest: null }),
      } as never,
    });
    expect((await slot.findByLabelText("Model")).textContent).toBe("Jev");
    expect(slot.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(slot.queryByRole("button", { name: "Save provider" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Test connection" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("saves computer, TypeSafe provider, and key in one request and confirms with a BB toast", async () => {
    const successToast = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, message: "Settings saved." }), { status: 200 });
    });
    const slot = renderSlot(settingsSection, {}, {
      rpc: {
        "settings.hosts": () => [{ hostId: "host_a", name: "Shared computer", status: "connected", phase: "active", os: "linux", arch: "x64", browserState: "ready", desktopState: "ready", providerState: "ready" }],
        "settings.get": () => ({ selectedHostId: null, provider: "jev", model: "jev-latest", keyStatus: "missing", lastTest: null }),
      } as never,
    });
    fireEvent.change(await slot.findByLabelText("Computer host"), { target: { value: "host_a" } });
    fireEvent.change(slot.getByLabelText("TypeSafe API key"), { target: { value: "synthetic-only" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(successToast).toHaveBeenCalledWith("Settings saved"));
    expect(slot.queryByText("Settings saved.")).toBeNull();
    expect(calls).toEqual([{ hostId: "host_a", provider: "jev", key: "synthetic-only" }]);
    expect(slot.inspection.rpcCalls.some((call) => JSON.stringify(call).includes("synthetic-only"))).toBe(false);
    slot.lifecycle.unmount();
  });

  it("saves OpenRouter as a Jev provider through the same form action", async () => {
    const successToast = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, message: "Settings saved." }), { status: 200 });
    });
    const slot = renderSlot(settingsSection, {}, {
      rpc: {
        "settings.hosts": () => [],
        "settings.get": () => ({ selectedHostId: null, provider: "jev", model: "jev-latest", keyStatus: "configured", lastTest: null }),
      } as never,
    });
    fireEvent.change(await slot.findByLabelText("Provider"), { target: { value: "openrouter" } });
    fireEvent.change(slot.getByLabelText("OpenRouter API key"), { target: { value: "synthetic-openrouter" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(successToast).toHaveBeenCalledWith("Settings saved"));
    expect(calls).toEqual([{ hostId: null, provider: "openrouter", key: "synthetic-openrouter" }]);
    slot.lifecycle.unmount();
  });
});
