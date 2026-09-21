import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ActionJournal } from "../../src/core/journal.js";
import { makeRoute } from "../contracts/fixtures.js";
import { sha256 } from "../../src/core/hash.js";

describe("ActionJournal", () => {
  it("reports an intent without outcome as an uncertain mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wayfinder-journal-"));
    const journal = new ActionJournal(join(directory, "actions.jsonl"));
    const route = makeRoute();
    await journal.recordIntent({
      actionId: "action_one",
      runId: "run_one",
      routePolicyHash: sha256(route),
      observation: { adapter: "browser", hostId: route.identity.hostId, resourceId: "tab_one", resourceGeneration: "generation_one", snapshotId: "snapshot_one", observedAt: 1 },
      action: { kind: "browser.back" },
      intentRecordedAt: 2,
    });
    expect(await journal.uncertainIntents("run_one")).toHaveLength(1);
    await journal.recordOutcome({ actionId: "action_one", state: "completed", dispatchedAt: 3, outcomeRecordedAt: 4, summary: "done", postObservation: null, error: null });
    expect(await journal.uncertainIntents("run_one")).toHaveLength(0);
  });
});
