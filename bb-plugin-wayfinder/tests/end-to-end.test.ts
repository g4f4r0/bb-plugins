import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";

import hostEntry from "../host.js";
import plugin from "../server.js";
import { makeRoute } from "./contracts/fixtures.js";

const TERMINAL = ["passed", "failed", "blocked", "cancelled", "timed_out", "interrupted"];

function setup() {
  const hostHarness = experimental_createHostEntryHarness(hostEntry);
  const { bb, harness } = createFakePluginHost({
    pluginId: "wayfinder",
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: "env_real", projectId: "proj_real" }) },
      environments: { get: async () => ({ id: "env_real", hostId: "host_test" }) },
    } as never,
    experimental_callHostRpc: async (call) => hostHarness.experimental_call(call.method as never, call.input as never),
  });
  plugin(bb);
  return { hostHarness, harness };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

describe("Wayfinder browser -> Computer -> inline screenshot (server <-> host contracts, real Fortress fixture)", () => {
  it("binds identity to the thread, dedupes, serves frames and private artifacts", async () => {
    const { hostHarness, harness } = setup();
    cleanup = async () => { await harness.lifecycle.dispose(); await hostHarness.experimental_dispose(); };
    expect(harness.inspection.registrations.settingsDescriptors).toEqual({});
    expect(harness.inspection.registrations.rpcMethods).toContain("settings.selectHost");

    // Route input lies about host/thread/environment; the thread's real environment wins.
    const route = makeRoute();
    const forged = { ...route, identity: { hostId: "host_evil", threadId: "thr_evil", projectId: null, environmentId: "env_evil" } };
    const started = JSON.parse(String(await harness.callAgentTool("wayfinder_start", { idempotencyKey: "k1", route: forged }, { threadId: "thr_owner" }))) as { runId: string; deduplicated: boolean };
    expect(started.deduplicated).toBe(false);
    const startCall = harness.inspection.experimental_hostRpcCalls.find((call) => call.method === "runs.start");
    expect((startCall?.input as { route: { identity: unknown } }).route.identity).toEqual({ hostId: "host_test", threadId: "thr_owner", projectId: "proj_real", environmentId: "env_real" });

    // Same key + same route dedupes; same key + different route is rejected.
    const again = JSON.parse(String(await harness.callAgentTool("wayfinder_start", { idempotencyKey: "k1", route: forged }, { threadId: "thr_owner" }))) as { runId: string; deduplicated: boolean };
    expect(again).toMatchObject({ runId: started.runId, deduplicated: true });
    await expect(harness.callAgentTool("wayfinder_start", { idempotencyKey: "k1", route: { ...forged, goal: "something else" } }, { threadId: "thr_owner" })).rejects.toThrow(/different route/u);
    expect(harness.inspection.experimental_hostRpcCalls.filter((call) => call.method === "runs.start")).toHaveLength(1);

    // Live frame while running (or its explicit ended state afterwards).
    const live = await harness.fetchHttp("GET", "/v1/live/frame?runId=" + started.runId);
    expect([200, 204]).toContain(live.status);
    expect((await harness.fetchHttp("GET", "/v1/live/frame?runId=run_unknown")).status).toBe(404);

    let status = await harness.callRpc("runs.status", { runId: started.runId }) as { state: string };
    for (let i = 0; i < 150 && !TERMINAL.includes(status.state); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await harness.callRpc("runs.status", { runId: started.runId }) as { state: string };
    }
    expect(status.state, JSON.stringify((status as { error?: unknown }).error)).toBe("passed");
    expect(harness.inspection.realtimeSignals.length).toBeGreaterThan(0);

    const snapshot = await harness.callRpc("computer.snapshot", { hostId: "host_test", selectedRunId: started.runId }) as { selectedRun: { state: string } | null };
    expect(snapshot.selectedRun?.state).toBe("passed");

    // Private, run-scoped artifact list/get/inline/download.
    const list = await harness.callRpc("artifacts.list", { threadId: "thr_owner", runId: started.runId, cursor: null, limit: 10 }) as { artifacts: { artifactId: string; threadId: string }[] };
    expect(list.artifacts).toHaveLength(1);
    const artifact = list.artifacts[0]!;
    expect(artifact.threadId).toBe("thr_owner");
    expect(await harness.callRpc("artifacts.get", { threadId: "thr_owner", artifactId: artifact.artifactId })).toMatchObject({ artifactId: artifact.artifactId });
    await expect(harness.callRpc("artifacts.get", { threadId: "thr_other", artifactId: artifact.artifactId })).rejects.toThrow();
    expect(((await harness.callRpc("artifacts.list", { threadId: "thr_other", runId: started.runId, cursor: null, limit: 10 })) as { artifacts: unknown[] }).artifacts).toEqual([]);

    const query = `artifactId=${artifact.artifactId}&threadId=thr_owner`;
    const inline = await harness.fetchHttp("GET", `/v1/artifacts/inline?${query}`);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await inline.arrayBuffer());
    expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    const download = await harness.fetchHttp("GET", `/v1/artifacts/download?${query}`);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment/u);
    expect((await harness.fetchHttp("GET", `/v1/artifacts/inline?artifactId=${artifact.artifactId}&threadId=thr_other`)).status).toBe(404);

    // An up-to-date viewer must still learn the run ended (else the relay would keep stale live pixels).
    const latest = await hostHarness.experimental_call("media.latest", { expectedHostId: "host_test", runId: started.runId, afterSequence: 999 });
    expect(latest.frame?.state).toBe("disconnected");

    // Ended run: no stale pixels, explicit state.
    const ended = await harness.fetchHttp("GET", `/v1/live/frame?runId=${started.runId}`);
    expect(ended.status).toBe(204);
    expect(ended.headers.get("x-wayfinder-frame-state")).toBe("disconnected");
  }, 30_000);
});
