import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import hostEntry, { jevProviderTarget } from "../host.js";
import { makeRoute } from "./contracts/fixtures.js";
import { sha256 } from "../src/core/hash.js";

const TEST_PATHS = { dataDir: join(tmpdir(), `wayfinder-host-${randomUUID()}`), tempDir: join(tmpdir(), `wayfinder-host-tmp-${randomUUID()}`) };
const createHarness = () => experimental_createHostEntryHarness(hostEntry, { experimental_paths: TEST_PATHS });

describe("Wayfinder host integration", () => {
  it("routes Jev through the selected provider's System One endpoint", () => {
    expect(jevProviderTarget("jev")).toEqual({ endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" });
    expect(jevProviderTarget("openrouter")).toEqual({ endpoint: "https://openrouter.ai/api/v1/systemone", model: "~typesafe/jev-latest" });
  });
  it("probes capabilities and validates strict input", async () => {
    const harness = createHarness();
    const result = await harness.experimental_call("capabilities.probe", { expectedHostId: "host_test", provider: "fixture" });
    expect(result.hostId).toBe("host_test");
    expect(result.decisionProvider.state).toBe("ready");
    await expect(
      harness.experimental_call(
        "capabilities.probe",
        { expectedHostId: "host_test", unknown: true } as never,
      ),
    ).rejects.toThrow();
    await harness.experimental_dispose();
  });

  it("does not substitute the fixture or launch Fortress when provider configuration is missing", async () => {
    const harness = createHarness();
    const route = { ...makeRoute(), decisionProvider: undefined };
    const runId = "run_missing_provider";
    await harness.experimental_call("runs.start", { expectedHostId: route.identity.hostId, runId, routeHash: sha256(route), route: route as never });
    let status = await harness.experimental_call("runs.status", { expectedHostId: route.identity.hostId, runId });
    for (let attempt = 0; attempt < 20 && status.state === "queued"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await harness.experimental_call("runs.status", { expectedHostId: route.identity.hostId, runId });
    }
    expect(status.state).toBe("blocked");
    expect(status.error?.message).toMatch(/decisionProvider must be explicitly selected/iu);
    await harness.experimental_dispose();
  });

  it("blocks real providers before launch without a verified Infisical scope", async () => {
    const harness = createHarness();
    const route = { ...makeRoute(), decisionProvider: { provider: "jev" as const, model: "jev-latest", endpoint: "https://api.typesafe.ai/v1/systemone" } };
    const runId = "run_unverified_provider";
    await harness.experimental_call("runs.start", { expectedHostId: route.identity.hostId, runId, routeHash: sha256(route), route });
    let status = await harness.experimental_call("runs.status", { expectedHostId: route.identity.hostId, runId });
    for (let attempt = 0; attempt < 400 && status.state === "queued"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await harness.experimental_call("runs.status", { expectedHostId: route.identity.hostId, runId });
    }
    expect(status.state).toBe("blocked");
    expect(status.error?.message).toMatch(/Infisical/iu);
    await harness.experimental_dispose();
  });

  it("runs the owned Fortress fixture and retains screenshot evidence", async () => {
    const harness = createHarness();
    const route = makeRoute();
    const runId = "run_fixture_host";
    await harness.experimental_call("runs.start", { expectedHostId: route.identity.hostId, runId, routeHash: sha256(route), route });
    let status = await harness.experimental_call("runs.status", { expectedHostId: route.identity.hostId, runId });
    for (let attempt = 0; attempt < 100 && !["passed", "failed", "blocked", "cancelled", "timed_out", "interrupted"].includes(status.state); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await harness.experimental_call("runs.status", { expectedHostId: route.identity.hostId, runId });
    }
    expect(status.state, JSON.stringify(status.error)).toBe("passed");
    const artifactId = status.checkpoints[0]?.evidenceArtifactIds[0];
    expect(artifactId).toMatch(/^art_/u);
    const media = await harness.experimental_call("media.latest", { expectedHostId: route.identity.hostId, runId, afterSequence: null });
    expect(media.frame?.bytesBase64.length).toBeGreaterThan(1_000);
    const range = await harness.experimental_call("artifacts.readRange", { expectedHostId: route.identity.hostId, artifactId: artifactId!, range: { start: 0, endInclusive: 31 } });
    expect(range.bytesBase64.length).toBeGreaterThan(0);
    await harness.experimental_dispose();
  }, 20_000);
});
