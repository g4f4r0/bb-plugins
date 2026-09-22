// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("shows setup required instead of a fake view when no host is selected", async () => {
    const slot = renderSlot(panel, { threadId: "thr_a", params: null }, { rpc: {} });
    await slot.findByText("Setup required");
    expect(slot.inspection.rpcCalls).toEqual([{ method: "settings.get", input: {} }]);
  });

  it("shows readiness, queue, and owner, and separates a selected historical run from the controller", async () => {
    const run = {
      runId: "run_old",
      routeHash: SHA,
      state: "passed",
    };
    const slot = renderSlot<PluginThreadPanelProps, UiRpcContract>(
      panel,
      { threadId: "thr_a", params: { runId: "run_old" } },
      {
        rpc: {
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
              hostId: "host_1",
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
        } as never,
      },
    );
    await slot.findByText("Fortress browser lease unavailable");
    expect(slot.getByText("No run is controlling the computer.")).toBeDefined();
    expect(slot.getByText("run_q")).toBeDefined();
    expect(slot.getByText("Selected run (not controlling)")).toBeDefined();
    expect(slot.getByText(`Run ${run.runId} was not found.`)).toBeDefined();
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "computer.snapshot", input: { hostId: "host_1", selectedRunId: "run_old" } });
    fireEvent.click(slot.getByText("run_q"));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "computer.snapshot", input: { hostId: "host_1", selectedRunId: "run_q" } }));
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
});

describe("Settings section", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a host dropdown from real enrolled hosts, disables disconnected entries, and never shows a raw hostId text field", async () => {
    const slot = renderSlot(
      settingsSection,
      {},
      {
        rpc: {
          "settings.hosts": () =>
            [
              { hostId: "host_a", name: "Shared computer", status: "connected", phase: "active" },
              { hostId: "host_b", name: "Old laptop", status: "disconnected", phase: "suspended" },
            ] as never,
          "settings.get": () =>
            ({ selectedHostId: "host_a", provider: "openrouter", model: "openai/test", keyStatus: "missing", lastTest: null }) as never,
        } as never,
      },
    );
    const select = (await slot.findByLabelText("Computer host")) as HTMLSelectElement;
    expect(select.value).toBe("host_a");
    const options = Array.from(select.options).map((option) => ({ value: option.value, disabled: option.disabled }));
    expect(options).toContainEqual({ value: "host_b", disabled: true });
    expect(slot.queryByLabelText(/host id/iu)).toBeNull();
    expect(slot.getByText("Missing")).toBeDefined();
    slot.lifecycle.unmount();
  });

  it("the API key field is a masked password input that never comes prefilled with a value", async () => {
    const slot = renderSlot(
      settingsSection,
      {},
      {
        rpc: {
          "settings.hosts": () => [] as never,
          "settings.get": () =>
            ({ selectedHostId: null, provider: "openrouter", model: "openai/test", keyStatus: "configured", lastTest: null }) as never,
        } as never,
      },
    );
    const input = (await slot.findByLabelText(/API key/iu)) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(slot.getByText("Configured")).toBeDefined();
    slot.lifecycle.unmount();
  });

  it("saving a key posts to the narrowly scoped /settings/key route, clears the field, and never rpc-calls with the key", async () => {
    const fetchCalls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, keyStatus: "configured", message: "Saved to the verified Infisical scope." }), { status: 200 });
    });
    const slot = renderSlot(
      settingsSection,
      {},
      {
        rpc: {
          "settings.hosts": () => [] as never,
          "settings.get": () =>
            ({ selectedHostId: null, provider: "openrouter", model: "openai/test", keyStatus: "missing", lastTest: null }) as never,
        } as never,
      },
    );
    const input = (await slot.findByLabelText(/API key/iu)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-typed-by-user" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchCalls.length).toBe(1));
    expect(fetchCalls[0]?.url).toBe("/api/v1/plugins/wayfinder/http/settings/key");
    expect(fetchCalls[0]?.body).toEqual({ provider: "openrouter", key: "sk-typed-by-user" });
    await waitFor(() => expect((slot.getByLabelText(/API key/iu) as HTMLInputElement).value).toBe(""));
    expect(slot.inspection.rpcCalls.some((call) => JSON.stringify(call).includes("sk-typed-by-user"))).toBe(false);
    slot.lifecycle.unmount();
  });

  it("testing a key posts to /settings/key/test and surfaces the readiness message without the key", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: false, status: 401, message: "rejected" }), { status: 200 }));
    const slot = renderSlot(
      settingsSection,
      {},
      {
        rpc: {
          "settings.hosts": () => [] as never,
          "settings.get": () =>
            ({ selectedHostId: null, provider: "openrouter", model: "openai/test", keyStatus: "configured", lastTest: null }) as never,
        } as never,
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Test connection" }));
    await slot.findByText("rejected");
    slot.lifecycle.unmount();
  });
});
