import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { AdapterObservation, AutomationAdapter, DecisionProvider } from "../../src/contracts/adapter.js";
import type { CheckpointResult } from "../../src/contracts/run.js";
import { SingleControllerQueue } from "../../src/core/controller-queue.js";
import { wayfinderError } from "../../src/core/errors.js";
import { ActionJournal } from "../../src/core/journal.js";
import type { ActionCatalog } from "../../worker/action-catalog.js";
import { RunEngine } from "../../worker/engine.js";
import { makeRoute } from "../contracts/fixtures.js";

const hash = "a".repeat(64);

function observation(pathname: string): AdapterObservation {
  return {
    identity: { adapter: "browser", hostId: "host_test", resourceId: "tab_one", resourceGeneration: "generation_one", snapshotId: `snapshot_${pathname.replace(/\W/gu, "") || "root"}`, observedAt: Date.now() },
    title: "Fixture", location: `http://127.0.0.1:4173${pathname}`, text: "Create local report",
    targets: [{ targetId: "create", resourceGeneration: "generation_one", role: "button", name: "Create local report", valueSummary: null, bounds: null, allowedOperations: ["click"] }],
    stateHash: hash, changedTargetIds: [], humanActivityDetected: false,
  };
}

function adapter(options: { path: string; executeFails?: boolean }): AutomationAdapter {
  const observed = observation(options.path);
  return {
    kind: "browser",
    observe: () => Effect.succeed(observed),
    execute: (intent) => options.executeFails
      ? Effect.fail(wayfinderError("provider-unavailable", "act", "transport disappeared"))
      : Effect.succeed({ actionId: intent.actionId, state: "completed", dispatchedAt: Date.now(), outcomeRecordedAt: Date.now(), summary: "clicked", postObservation: observed, error: null }),
    verify: (checkpoint) => Effect.succeed<CheckpointResult>({ checkpoint, outcome: options.path === "/done" ? "pass" : "fail", observedAt: Date.now(), summary: "deterministic URL check", evidenceArtifactIds: [] }),
    close: () => Effect.void,
  };
}

const provider: DecisionProvider = {
  decide: (request) => Effect.succeed({
    operationChoiceId: request.operationChoices[0]!.choiceId,
    targetChoiceId: request.targetChoices[0]!.choiceId,
    operationProbabilities: [{ choiceId: request.operationChoices[0]!.choiceId, probability: 1 }],
    targetProbabilities: [{ choiceId: request.targetChoices[0]!.choiceId, probability: 1 }],
    confidence: 0.9, providerModel: "synthetic-provider", latencyMs: 1,
  }),
};

const catalog: ActionCatalog = {
  choices: (_route, observed) => ({
    operationChoices: [{ choiceId: "op_browser_click", label: "browser.click" }],
    targetChoices: [{ choiceId: "target_create", targetId: "create", label: "Create" }],
    resolve: () => ({ kind: "browser.click", target: { targetId: "create", resourceGeneration: "generation_one", snapshotId: observed.identity.snapshotId } }),
  }),
};

describe("RunEngine", () => {
  it("passes only after deterministic checkpoint verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wayfinder-engine-"));
    const engine = new RunEngine({ queue: new SingleControllerQueue(), journal: new ActionJournal(join(directory, "journal.jsonl")), adapters: new Map([["browser", adapter({ path: "/done" })]]), provider, actionCatalog: catalog });
    const result = await engine.run({ runId: "run_pass", route: makeRoute(), signal: new AbortController().signal });
    expect(result.state).toBe("passed");
    expect(result.decisions).toBe(0);
    expect(result.checkpoints[0]?.outcome).toBe("pass");
  });

  it("does not replay an action whose dispatch outcome is uncertain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wayfinder-engine-"));
    const journal = new ActionJournal(join(directory, "journal.jsonl"));
    const engine = new RunEngine({ queue: new SingleControllerQueue(), journal, adapters: new Map([["browser", adapter({ path: "/", executeFails: true })]]), provider, actionCatalog: catalog });
    const result = await engine.run({ runId: "run_uncertain", route: makeRoute(), signal: new AbortController().signal });
    expect(result.state).toBe("interrupted");
    expect(result.error?.code).toBe("uncertain-mutation");
    expect(await journal.uncertainIntents("run_uncertain")).toHaveLength(1);
  });
});
