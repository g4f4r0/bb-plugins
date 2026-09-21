import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";

import hostEntry from "../host.js";
import { makeRoute } from "./contracts/fixtures.js";
import { sha256 } from "../src/core/hash.js";

describe("Wayfinder host integration", () => {
  it("probes capabilities and validates strict input", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const result = await harness.experimental_call("capabilities.probe", { expectedHostId: "host_test" });
    expect(result.hostId).toBe("host_test");
    expect(result.decisionProvider.state).toBe("setup-required");
    await expect(
      harness.experimental_call(
        "capabilities.probe",
        { expectedHostId: "host_test", unknown: true } as never,
      ),
    ).rejects.toThrow();
    await harness.experimental_dispose();
  });

  it("runs the owned Fortress fixture and retains screenshot evidence", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const route = makeRoute();
    const runId = "run_fixture_host";
    await harness.experimental_call("runs.start", { expectedHostId: route.identity.hostId, runId, routeHash: sha256(route), route });
    let status = await harness.experimental_call("runs.status", { expectedHostId: route.identity.hostId, runId });
    for (let attempt = 0; attempt < 100 && !["passed", "failed", "blocked", "cancelled", "timed_out", "interrupted"].includes(status.state); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await harness.experimental_call("runs.status", { expectedHostId: route.identity.hostId, runId });
    }
    expect(status.state).toBe("passed");
    const artifactId = status.checkpoints[0]?.evidenceArtifactIds[0];
    expect(artifactId).toMatch(/^art_/u);
    const media = await harness.experimental_call("media.latest", { expectedHostId: route.identity.hostId, runId, afterSequence: null });
    expect(media.frame?.bytesBase64.length).toBeGreaterThan(1_000);
    const range = await harness.experimental_call("artifacts.readRange", { expectedHostId: route.identity.hostId, artifactId: artifactId!, range: { start: 0, endInclusive: 31 } });
    expect(range.bytesBase64.length).toBeGreaterThan(0);
    await harness.experimental_dispose();
  }, 20_000);
});
