import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { BrowserAdapter } from "../../src/adapters/browser.js";
import { WebSocketCdpTransport, type CdpEvent, type CdpTransport } from "../../src/adapters/cdp-client.js";
import type { WayfinderRoute } from "../../src/contracts/route.js";
import { ControlGate } from "../../src/core/control-gate.js";
import { sha256 } from "../../src/core/hash.js";
import { makeRoute } from "../contracts/fixtures.js";

class FakeCdp implements CdpTransport {
  readonly listeners = new Set<(event: CdpEvent) => void>();
  commands: string[] = [];
  typedValue = "";
  constructor(readonly textbox = false) {}
  command<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.commands.push(method);
    if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: [
      { nodeId: "one", backendDOMNodeId: 1, role: { value: "StaticText" }, name: { value: "Waiting" } },
      this.textbox
        ? { nodeId: "two", backendDOMNodeId: 2, role: { value: "textbox" }, name: { value: "Synthetic account" }, value: { value: this.typedValue } }
        : { nodeId: "two", backendDOMNodeId: 2, role: { value: "button" }, name: { value: "Create local report" } },
    ] } as T);
    if (method === "Target.getTargetInfo") return Promise.resolve({ targetInfo: { targetId: "tab_one", title: "Fixture", url: "http://127.0.0.1:4173/" } } as T);
    if (method === "DOM.getBoxModel") return Promise.resolve({ model: { content: [0, 0, 100, 0, 100, 20, 0, 20] } } as T);
    if (method === "Input.insertText") this.typedValue = String(params.text ?? "");
    return Promise.resolve({} as T);
  }
  onEvent(listener: (event: CdpEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close() {}
}

describe("BrowserAdapter", () => {
  it("refuses a publicly addressed CDP endpoint", async () => {
    await expect(WebSocketCdpTransport.connect("ws://203.0.113.10:9222/devtools/browser/test", { signal: new AbortController().signal })).rejects.toMatchObject({ code: "policy-denied" });
  });

  it("observes code-owned AX targets and rejects a stale action", async () => {
    const route: WayfinderRoute = { ...makeRoute(), allowedActions: ["browser.click"] };
    const transport = new FakeCdp();
    const adapter = new BrowserAdapter({ route, hostId: "host_test", tabId: "tab_one", resourceGeneration: "generation_one", transport, settleMs: 1 });
    const context = { signal: new AbortController().signal, expectedHostId: "host_test" };
    const observation = await Effect.runPromise(adapter.observe(context));
    expect(observation.targets[0]?.name).toBe("Create local report");
    await expect(Effect.runPromise(adapter.execute({
      actionId: "action_one", runId: "run_one", routePolicyHash: sha256(route), observation: { ...observation.identity, snapshotId: "snapshot_stale" },
      action: { kind: "browser.click", target: { targetId: observation.targets[0]!.targetId, resourceGeneration: "generation_one", snapshotId: "snapshot_stale" } }, intentRecordedAt: 1,
    }, context))).rejects.toThrow(/stale-observation/iu);
  });

  it("verifies URL independently of the decision provider", async () => {
    const route = makeRoute();
    const adapter = new BrowserAdapter({ route, hostId: "host_test", tabId: "tab_one", resourceGeneration: "generation_one", transport: new FakeCdp() });
    const context = { signal: new AbortController().signal, expectedHostId: "host_test" };
    const observation = await Effect.runPromise(adapter.observe(context));
    const result = await Effect.runPromise(adapter.verify(route.checkpoints[0]!, observation, context));
    expect(result.outcome).toBe("fail");
  });

  it("dispatches human input only for the viewer holding control", async () => {
    const route = makeRoute();
    const transport = new FakeCdp();
    const gate = new ControlGate();
    const adapter = new BrowserAdapter({ route, hostId: "host_test", tabId: "tab_one", resourceGeneration: "generation_one", transport, controlGate: gate });
    const signal = new AbortController().signal;
    await expect(adapter.dispatchHumanInput({ kind: "click", x: 20, y: 30, button: "left" }, "viewer_a", signal)).rejects.toThrow(/not active/iu);
    await gate.acquire("viewer_a", signal);
    await adapter.dispatchHumanInput({ kind: "click", x: 20, y: 30, button: "left" }, "viewer_a", signal);
    await adapter.dispatchHumanInput({ kind: "text", text: "hello" }, "viewer_a", signal);
    await adapter.dispatchHumanInput({ kind: "key", key: "Enter", code: "Enter", modifiers: 0 }, "viewer_a", signal);
    expect(transport.commands.filter((command) => command === "Input.dispatchMouseEvent")).toHaveLength(2);
    expect(transport.commands.filter((command) => command === "Input.dispatchKeyEvent")).toHaveLength(2);
    expect(transport.typedValue).toBe("hello");
    gate.dispose();
  });

  it("does not expose a protected value in the post-action observation", async () => {
    const route = { ...makeRoute(), allowedActions: ["browser.type" as const] };
    const transport = new FakeCdp(true);
    const adapter = new BrowserAdapter({ route, hostId: "host_test", tabId: "tab_one", resourceGeneration: "generation_one", transport, settleMs: 1, resolveData: async () => "protected-canary" });
    const context = { signal: new AbortController().signal, expectedHostId: "host_test" };
    const observed = await Effect.runPromise(adapter.observe(context));
    const target = observed.targets[0]!;
    const outcome = await Effect.runPromise(adapter.execute({
      actionId: "action_protected", runId: "run_one", routePolicyHash: sha256(route), observation: observed.identity,
      action: { kind: "browser.type", target: { targetId: target.targetId, resourceGeneration: target.resourceGeneration, snapshotId: observed.identity.snapshotId }, value: { kind: "protected-ref", dataRefId: "secret_one" } }, intentRecordedAt: 1,
    }, context));
    expect(outcome.postObservation?.targets[0]?.valueSummary).toBeNull();
    expect(JSON.stringify(outcome)).not.toContain("protected-canary");
  });
});
