import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { JevDecisionProvider } from "../../src/adapters/jev.js";

describe("JevDecisionProvider", () => {
  it("rejects model-invented operation IDs", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ answers: {
      operation: { choice: "op_arbitrary_script", probabilities: { op_arbitrary_script: 1 }, confidence: 1 },
    }, usage: { input_tokens: 10 } }), { status: 200 });
    const provider = new JevDecisionProvider({ endpoint: "https://api.typesafe.invalid/v1/systemone", model: "jev-test", apiKey: "in-memory-test-key", fetchImpl });
    const hash = "a".repeat(64);
    await expect(Effect.runPromise(provider.decide({
      runId: "run_one", goal: "Click approved target",
      observation: { identity: { adapter: "browser", hostId: "host_test", resourceId: "tab_one", resourceGeneration: "generation_one", snapshotId: "snapshot_one", observedAt: 1 }, title: "", location: null, text: "", targets: [], stateHash: hash, changedTargetIds: [], humanActivityDetected: false },
      operationChoices: [{ choiceId: "op_browser_click", label: "browser.click" }], targetChoices: [], recentOutcomeSummaries: [],
    }, { signal: new AbortController().signal, expectedHostId: "host_test" }))).rejects.toThrow(/provider-unavailable/iu);
  });

  it("uses typed System One choice questions and returns distributions", async () => {
    const requestBodies: Array<{ questions?: Record<string, { type?: string }> }> = [];
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as (typeof requestBodies)[number]);
      return new Response(JSON.stringify({ answers: {
        operation: { choice: "op_browser_click", probabilities: { op_browser_click: 1 }, confidence: 1 },
        target: { choice: "target_create", probabilities: { target_create: 1 }, confidence: 0.91 },
      }, usage: { input_tokens: 12 } }), { status: 200 });
    };
    const provider = new JevDecisionProvider({ endpoint: "https://api.typesafe.invalid/v1/systemone", model: "jev-test", apiKey: "in-memory-test-key", fetchImpl });
    const hash = "a".repeat(64);
    const decision = await Effect.runPromise(provider.decide({
      runId: "run_two", goal: "Click approved target",
      observation: { identity: { adapter: "browser", hostId: "host_test", resourceId: "tab_one", resourceGeneration: "generation_one", snapshotId: "snapshot_one", observedAt: 1 }, title: "", location: null, text: "Create", targets: [{ targetId: "create", resourceGeneration: "generation_one", role: "button", name: "Create", valueSummary: null, bounds: null, allowedOperations: ["click"] }], stateHash: hash, changedTargetIds: [], humanActivityDetected: false },
      operationChoices: [{ choiceId: "op_browser_click", label: "browser.click" }], targetChoices: [{ choiceId: "target_create", targetId: "create", label: "Create" }], recentOutcomeSummaries: [],
    }, { signal: new AbortController().signal, expectedHostId: "host_test" }));
    expect(decision.targetChoiceId).toBe("target_create");
    expect(requestBodies[0]?.questions?.operation?.type).toBe("choice");
    expect(requestBodies[1]?.questions?.target?.type).toBe("choice");
    expect(JSON.stringify(requestBodies)).not.toContain("messages");
  });
});
