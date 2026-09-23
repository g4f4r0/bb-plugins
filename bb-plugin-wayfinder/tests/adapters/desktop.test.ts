import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import { DesktopAutomationAdapter } from "../../src/adapters/desktop.js";
import { ControlGate } from "../../src/core/control-gate.js";
import type { DesktopRuntime } from "../../src/core/desktop-runtime.js";
import { routeSchema } from "../../src/contracts/route.js";
import { makeRoute } from "../contracts/fixtures.js";

const window = { pid: 111, windowId: 222, title: "Product - Chromium", x: 100, y: 55, width: 1080, height: 610 };
const context = { signal: new AbortController().signal, expectedHostId: "host_test" };
const element = (index: number, role: string, label: string, y: number, actions = ["press"]) =>
  ({ element_index: index, element_token: `s00000001:${index}`, enabled: true, frame: { x: 700, y, w: 220, h: 48 }, role, label, actions });
function route() {
  return routeSchema.parse({ ...makeRoute(), desktop: { applications: [{ appId: "browser", executable: "/usr/bin/chromium", windowTitle: "Product", titleMatch: "prefix" }],
    allowedTargetNames: ["Decline", "One Time Purchase", "ADD TO CART", "CHECKOUT"] },
    allowedActions: ["desktop.click", "desktop.scroll"], checkpoints: [{ checkpointId: "checkout", kind: "visible-text", timing: "final", surface: "desktop", text: "Checkout - Jackfir", match: "contains", caseSensitive: true }] });
}

describe("native desktop Jev targets", () => {
  it("offers only permitted visible modal choices and never exposes checkout fields", async () => {
    const runtime = { windowState: vi.fn(async () => ({ window_title: "Product - Chromium", window_bounds: { x: 100, y: 55, width: 1080, height: 610 },
      elements: [{ ...element(1, "alert", "Cookie consent", 400, []), frame: { x: 270, y: 400, w: 752, h: 255 } },
        { ...element(2, "button", "Decline", 550), parent_index: 1 }, element(3, "radio button", "One Time Purchase", 525, ["check"]),
        element(4, "button", "ADD TO CART", 850), element(5, "entry", "Email", 490)] })) } as unknown as DesktopRuntime;
    const adapter = new DesktopAutomationAdapter({ runtime, route: route(), window, hostId: "host_test", controlGate: new ControlGate() });
    const observation = await Effect.runPromise(adapter.observe(context));
    expect(observation.targets.map((target) => target.name)).toEqual(["Decline"]);
    expect(observation.text).toContain("Product - Chromium");
  });

  it("offers a window-bound native page scroll and never repeats an unverified action", async () => {
    const runtime = { windowState: vi.fn(async () => ({ window_title: "Product - Chromium", elements: [element(10, "radio button", "One Time Purchase", 540, ["check"]) ] })),
      input: vi.fn(async () => {}) } as unknown as DesktopRuntime;
    const adapter = new DesktopAutomationAdapter({ runtime, route: route(), window, hostId: "host_test", controlGate: new ControlGate() });
    const before = await Effect.runPromise(adapter.observe(context));
    expect(before.targets.map((target) => target.targetId)).toContain("page_scroll");
    const target = before.targets.find((entry) => entry.targetId === "page_scroll")!;
    const intent = { actionId: "action_scroll", runId: "run_1", routePolicyHash: "0".repeat(64), observation: before.identity,
      action: { kind: "desktop.scroll" as const, direction: "down" as const, amount: "small" as const,
        target: { targetId: target.targetId, resourceGeneration: target.resourceGeneration, snapshotId: before.identity.snapshotId } }, intentRecordedAt: Date.now() };
    const result = await Effect.runPromise(adapter.execute(intent, context));
    expect(result.state).toBe("uncertain");
    expect((runtime.input as ReturnType<typeof vi.fn>)).toHaveBeenCalledExactlyOnceWith(
      { kind: "wheel", x: 910, y: 390, deltaX: 0, deltaY: 80 }, context.signal);
  });

  it("executes an approved Cua element token once and observes checkout before another decision", async () => {
    let title = "Your Cart - Chromium";
    const runtime = { windowState: vi.fn(async () => ({ window_title: title, elements: [element(6, "button", "CHECKOUT", 540)] })),
      clickElement: vi.fn(async () => { title = "Checkout - Jackfir"; }) } as unknown as DesktopRuntime;
    const adapter = new DesktopAutomationAdapter({ runtime, route: route(), window, hostId: "host_test", controlGate: new ControlGate() });
    const before = await Effect.runPromise(adapter.observe(context));
    const target = before.targets[0]!;
    const intent = { actionId: "action_1", runId: "run_1", routePolicyHash: "0".repeat(64), observation: before.identity,
      action: { kind: "desktop.click" as const, target: { targetId: target.targetId, resourceGeneration: target.resourceGeneration, snapshotId: before.identity.snapshotId } }, intentRecordedAt: Date.now() };
    const result = await Effect.runPromise(adapter.execute(intent, context));
    expect(result.state).toBe("completed");
    expect((runtime.clickElement as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(111, 222, "s00000001:6", context.signal);
    const after = await Effect.runPromise(adapter.observe(context));
    const checkpoint = route().checkpoints[0]!;
    expect((await Effect.runPromise(adapter.verify(checkpoint, after, context))).outcome).toBe("pass");
  });
});
