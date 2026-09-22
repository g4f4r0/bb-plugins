import { describe, expect, it } from "vitest";

import { ControlGate } from "../../src/core/control-gate.js";

const signal = () => new AbortController().signal;

describe("ControlGate", () => {
  it("hands control over only after the current atomic agent operation and resumes the agent on release", async () => {
    const gate = new ControlGate();
    let finishAgent!: () => void;
    const firstAgent = gate.runAgent(signal(), () => new Promise<void>((resolve) => { finishAgent = resolve; }));
    await Promise.resolve();

    let acquired = false;
    const takeover = gate.acquire("viewer_a", signal()).then((state) => { acquired = true; return state; });
    await Promise.resolve();
    expect(acquired).toBe(false);

    finishAgent();
    await expect(firstAgent).resolves.toBeUndefined();
    await expect(takeover).resolves.toBe("human");
    expect(gate.owns("viewer_a")).toBe(true);
    await expect(gate.acquire("viewer_b", signal())).resolves.toBe("busy");

    let agentResumed = false;
    const nextAgent = gate.runAgent(signal(), async () => { agentResumed = true; });
    await Promise.resolve();
    expect(agentResumed).toBe(false);
    expect(gate.release("viewer_a")).toBe(true);
    await nextAgent;
    expect(agentResumed).toBe(true);
  });

  it("expires an abandoned viewer lease", async () => {
    const gate = new ControlGate(5);
    await expect(gate.acquire("viewer_a", signal())).resolves.toBe("human");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(gate.acquire("viewer_b", signal())).resolves.toBe("human");
    gate.dispose();
  });
});
