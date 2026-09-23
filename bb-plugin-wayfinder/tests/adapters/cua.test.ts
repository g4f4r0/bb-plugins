import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { CuaAdapter } from "../../src/adapters/cua.js";
import { parseCuaResult, type CuaToolResult, type CuaTransport } from "../../src/adapters/cua-client.js";
import { cuaLaunchStrategy, DESKTOP_CAPABILITY_TOOLS, desktopInputCall } from "../../src/core/desktop-runtime.js";
import { sha256 } from "../../src/core/hash.js";
import { makeRoute } from "../contracts/fixtures.js";

class FakeCua implements CuaTransport {
  async call(tool: string): Promise<CuaToolResult> {
    if (tool === "list_windows") return { structuredContent: { windows: [{ pid: 42, window_id: 7, title: "Wayfinder fixture", executable: "wayfinder-fixture" }] } };
    if (tool === "get_window_state") return { structuredContent: {
      snapshot_id: "s12345678", window_title: "Wayfinder fixture",
      elements: [{ element_index: 1, element_token: "opaque", role: "button", label: "Create local report", enabled: true, frame: { x: 1, y: 2, w: 100, h: 20 } }],
    } };
    return { structuredContent: { ok: true } };
  }
  async close() {}
}

describe("Cua CLI responses", () => {
  it("uses Cua Driver's stable macOS permission identity", () => {
    expect(cuaLaunchStrategy("darwin")).toBe("launchservices");
    expect(cuaLaunchStrategy("linux")).toBe("embedded");
    expect(cuaLaunchStrategy("win32")).toBe("embedded");
  });

  it("uses the portable desktop target without legacy scope fields", () => {
    const call = desktopInputCall({ kind: "click", x: 120, y: 80, button: "left" });
    expect(call).toEqual({ tool: "click", payload: { target: { kind: "desktop", display_id: "primary" }, delivery_mode: "foreground", x: 120, y: 80, button: "left" } });
    expect(call.payload).not.toHaveProperty("scope");
    expect(desktopInputCall({ kind: "drag", fromX: 1, fromY: 2, toX: 30, toY: 40, button: "left", durationMs: 250 })).toMatchObject({ tool: "drag", payload: { from_x: 1, from_y: 2, to_x: 30, to_y: 40, duration_ms: 250 } });
  });

  it("keeps capture, accessibility inspection, and bounded input in the reviewed manifest", () => {
    expect(DESKTOP_CAPABILITY_TOOLS).toEqual(expect.arrayContaining(["get_desktop_state", "get_accessibility_tree", "get_window_state", "list_windows", "click", "drag", "type_text", "set_agent_cursor_enabled"]));
    expect(DESKTOP_CAPABILITY_TOOLS).not.toEqual(expect.arrayContaining(["launch_app", "kill_app", "clipboard_read"]));
  });

  it("accepts direct desktop-state output and fails closed on manifest refusals", () => {
    expect(parseCuaResult(JSON.stringify({ screen_width: 1280, screenshot_png_b64: "YWJj" }))).toMatchObject({ structuredContent: { screen_width: 1280, screenshot_png_b64: "YWJj" } });
    expect(parseCuaResult(JSON.stringify({ status: "refused", refusal: { code: "outside_manifest", message: "desktop denied" } }))).toMatchObject({ isError: true, content: [{ type: "text", text: "desktop denied" }] });
  });
});

describe("CuaAdapter", () => {
  it("binds the exact app/window and rejects a stale generation", async () => {
    const base = makeRoute();
    const route = { ...base, allowedActions: ["desktop.click" as const] };
    const adapter = new CuaAdapter({ route, hostId: "host_test", appId: "fixture_app", pid: 42, windowId: 7, resourceGeneration: "generation_one", transport: new FakeCua(), syntheticFixture: true });
    const context = { signal: new AbortController().signal, expectedHostId: "host_test" };
    const observation = await Effect.runPromise(adapter.observe(context));
    expect(observation.targets[0]?.bounds).toEqual({ x: 1, y: 2, width: 100, height: 20 });
    await expect(Effect.runPromise(adapter.execute({
      actionId: "action_one", runId: "run_one", routePolicyHash: sha256(route), observation: observation.identity,
      action: { kind: "desktop.click", target: { targetId: observation.targets[0]!.targetId, resourceGeneration: "generation_stale", snapshotId: observation.identity.snapshotId } }, intentRecordedAt: 1,
    }, context))).rejects.toThrow(/stale-observation/iu);
  });
});
