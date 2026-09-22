import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "../../server.js";
import { makeRoute } from "../contracts/fixtures.js";
import type { InfisicalScope, InfisicalClient, ProviderTestResult } from "../../src/core/infisical.js";

/** In-memory Infisical stand-in so these tests never shell out to a real CLI/project. */
function fakeInfisicalClient(initial: Record<string, string> = {}): InfisicalClient & { secrets: Record<string, string>; scopes: InfisicalScope[] } {
  const secrets: Record<string, string> = { ...initial };
  const scopes: InfisicalScope[] = [];
  return {
    secrets,
    scopes,
    async resolveSecret(scope: InfisicalScope, name: string) { scopes.push(scope); return secrets[name] ?? null; },
    async secretConfigured(scope: InfisicalScope, name: string) { scopes.push(scope); return name in secrets; },
    async setSecret(scope: InfisicalScope, name: string, value: string) { scopes.push(scope); secrets[name] = value; return true; },
    async testProviderKey(scope: InfisicalScope, name: string): Promise<ProviderTestResult> {
      scopes.push(scope);
      return name in secrets ? { ok: true, status: 200, message: "ready" } : { ok: false, status: 0, message: "missing" };
    },
  };
}

const HOST_A = {
  id: "host_a",
  name: "Shared computer",
  status: "connected" as const,
  createdAt: 1,
  lastRejectedProtocolVersion: null,
  lastSeenAt: 1,
  lifecycle: { message: null, pendingLog: "", phase: "active" as const, suspendedAt: null, teardown: null },
  machineProviderId: null,
  maxPermissionMode: "auto" as const,
  type: "persistent" as const,
  updatedAt: 1,
};
const HOST_B_DISCONNECTED = { ...HOST_A, id: "host_b", name: "Old laptop", status: "disconnected" as const, lifecycle: { ...HOST_A.lifecycle, phase: "suspended" as const } };

describe("Wayfinder settings", () => {
  it("uses the saved provider/model for real runs, ignoring stale route providers and endpoints", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "wayfinder",
      sdk: {
        hosts: { list: async () => [HOST_A] },
        threads: { get: async () => ({ environmentId: "env_test", projectId: "proj_test" }) },
        environments: { get: async () => ({ id: "env_test", hostId: "host_a" }) },
      } as never,
      experimental_callHostRpc: async (call) => ({ accepted: true, runId: (call.input as { runId: string }).runId }),
    });
    plugin(bb, { infisicalClient: fakeInfisicalClient() });
    try {
      await harness.callRpc("settings.saveProvider", { provider: "openrouter", model: "vendor/model" });
      await harness.callAgentTool("wayfinder_start", { idempotencyKey: "selected-provider", route: {
        ...makeRoute(), decisionProvider: { provider: "jev", model: "jev-latest", endpoint: "https://stale.example/api" },
      } }, { threadId: "thr_owner" });
      const call = harness.inspection.experimental_hostRpcCalls.find((entry) => entry.method === "runs.start");
      expect((call?.input as { route: { decisionProvider: unknown } }).route.decisionProvider)
        .toEqual({ provider: "openrouter", model: "~typesafe/jev-latest", endpoint: null });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("uses only the verified server-wide Infisical scope", async () => {
    const client = fakeInfisicalClient();
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: client });
    await harness.behavior.callRpc("settings.get", {});
    expect(client.scopes).toContainEqual({ projectId: "bd53277c-43aa-4093-8aea-1e4040fc1962", env: "prod", path: "/" });
    await harness.lifecycle.dispose();
  });

  it("declares no raw hostId setting; the host comes from a settingsSection backed by real host discovery", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [HOST_A] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    expect(harness.inspection.registrations.settingsDescriptors).toEqual({});
    expect(harness.inspection.registrations.rpcMethods).toContain("settings.hosts");
    expect(harness.inspection.registrations.rpcMethods).toContain("settings.get");
    expect(harness.inspection.registrations.rpcMethods).toContain("settings.selectHost");
    expect(harness.inspection.registrations.rpcMethods).toContain("settings.saveProvider");
    await harness.lifecycle.dispose();
  });

  it("lists enrolled hosts with friendly name and connection state", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [HOST_A, HOST_B_DISCONNECTED] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    const hosts = await harness.behavior.callRpc("settings.hosts", {});
    expect(hosts).toEqual([
      { hostId: "host_a", name: "Shared computer", status: "connected", phase: "active" },
      { hostId: "host_b", name: "Old laptop", status: "disconnected", phase: "suspended" },
    ]);
    await harness.lifecycle.dispose();
  });

  it("rejects selecting a host that is not enrolled", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [HOST_A] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    await expect(harness.behavior.callRpc("settings.selectHost", { hostId: "host_unknown" })).rejects.toThrow(/not enrolled/iu);
    await harness.lifecycle.dispose();
  });

  it("persists a valid host selection and returns it from settings.get", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [HOST_A] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    const after = await harness.behavior.callRpc("settings.selectHost", { hostId: "host_a" });
    expect((after as { selectedHostId: string | null }).selectedHostId).toBe("host_a");
    const state = await harness.behavior.callRpc("settings.get", {});
    expect((state as { selectedHostId: string | null }).selectedHostId).toBe("host_a");
    await harness.lifecycle.dispose();
  });

  it("clears a stale selection once its host is no longer enrolled, without auto-switching to another host", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [HOST_A] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    await harness.behavior.callRpc("settings.selectHost", { hostId: "host_a" });
    harness.sdk.stub("hosts.list", async () => [HOST_B_DISCONNECTED]);
    const state = await harness.behavior.callRpc("settings.get", {}) as { selectedHostId: string | null };
    expect(state.selectedHostId).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("keeps the model fixed to Jev when saving a provider", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    expect(await harness.behavior.callRpc("settings.saveProvider", { provider: "jev", model: "ignored" }))
      .toMatchObject({ provider: "jev", model: "jev-latest" });
    expect(await harness.behavior.callRpc("settings.saveProvider", { provider: "openrouter", model: "ignored" }))
      .toMatchObject({ provider: "openrouter", model: "~typesafe/jev-latest" });
    await harness.lifecycle.dispose();
  });

  it("saves computer, TypeSafe provider, fixed Jev model, and key through one endpoint", async () => {
    const client = fakeInfisicalClient();
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [HOST_A] } } });
    plugin(bb, { infisicalClient: client });
    const response = await harness.fetchHttp("POST", "/settings/save", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host_a", provider: "jev", key: "synthetic-only" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "Settings saved." });
    expect(client.secrets.TYPESAFE_API_KEY).toBe("synthetic-only");
    expect(await harness.callRpc("settings.get", {})).toMatchObject({ selectedHostId: "host_a", provider: "jev", model: "jev-latest", keyStatus: "configured" });
    await harness.lifecycle.dispose();
  });

  it("stores OpenRouter's Jev alias when OpenRouter is selected", async () => {
    const client = fakeInfisicalClient({ OPENROUTER_API_KEY: "synthetic-only" });
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [HOST_A] } } });
    plugin(bb, { infisicalClient: client });
    const response = await harness.fetchHttp("POST", "/settings/save", {
      headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId: "host_a", provider: "openrouter" }),
    });
    expect(response.status).toBe(200);
    expect(await harness.callRpc("settings.get", {})).toMatchObject({ provider: "openrouter", model: "~typesafe/jev-latest", keyStatus: "configured" });
    await harness.lifecycle.dispose();
  });

  it("exposes the key routes as narrowly scoped POSTs, not rpc or an agent tool", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    const routes = harness.inspection.registrations.httpRoutes;
    const keyRoute = routes.find((route) => route.path === "/settings/key");
    const testRoute = routes.find((route) => route.path === "/settings/key/test");
    expect(keyRoute?.method).toBe("POST");
    expect(keyRoute?.auth).toBe("local");
    expect(testRoute?.method).toBe("POST");
    expect(testRoute?.auth).toBe("local");
    expect(harness.inspection.registrations.rpcMethods).not.toContain("settings.saveKey");
    expect(harness.inspection.registrations.agentTools.map((tool) => tool.name)).not.toContain("wayfinder_save_key");
    await harness.lifecycle.dispose();
  });

  it("rejects an oversized /settings/key body instead of buffering it", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    const oversized = "x".repeat(20_000);
    const response = await harness.behavior.fetchHttp("POST", "/settings/key", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", key: oversized }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(oversized);
    await harness.lifecycle.dispose();
  });

  it("rejects a malformed /settings/key body without echoing it back", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    const response = await harness.behavior.fetchHttp("POST", "/settings/key", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "not-a-provider", key: "sk-value-should-not-echo" }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("sk-value-should-not-echo");
    await harness.lifecycle.dispose();
  });

  it("never returns a key value from /settings/key or /settings/key/test responses, even on success", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: fakeInfisicalClient() });
    const response = await harness.behavior.fetchHttp("POST", "/settings/key", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", key: "sk-must-not-appear-anywhere" }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("sk-must-not-appear-anywhere");
    expect(harness.inspection.logEntries.some((entry) => entry.message.includes("sk-must-not-appear-anywhere"))).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("saving a key makes settings.get report it configured, from a real (fake-backed) check, not an assumed flag", async () => {
    const client = fakeInfisicalClient();
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: client });
    let state = await harness.behavior.callRpc("settings.get", {}) as { keyStatus: string };
    expect(state.keyStatus).toBe("missing");
    const saveResponse = await harness.behavior.fetchHttp("POST", "/settings/key", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", key: "sk-real-value" }),
    });
    expect((await saveResponse.json()).ok).toBe(true);
    state = await harness.behavior.callRpc("settings.get", {}) as { keyStatus: string };
    expect(state.keyStatus).toBe("configured");
    expect(client.secrets.OPENROUTER_API_KEY).toBe("sk-real-value");
    await harness.lifecycle.dispose();
  });

  it("reports a failed CLI write as missing, not a false success", async () => {
    const client = fakeInfisicalClient();
    client.setSecret = async () => false;
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: client });
    const response = await harness.behavior.fetchHttp("POST", "/settings/key", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", key: "sk-value" }),
    });
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.keyStatus).toBe("missing");
    await harness.lifecycle.dispose();
  });

  it("/settings/key/test reports readiness from the provider probe and records the last test result (no secret)", async () => {
    const client = fakeInfisicalClient({ OPENROUTER_API_KEY: "sk-configured" });
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: client });
    const response = await harness.behavior.fetchHttp("POST", "/settings/key/test", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openrouter" }),
    });
    const body = await response.json();
    expect(body).toEqual({ ok: true, status: 200, message: "ready" });
    const state = await harness.behavior.callRpc("settings.get", {}) as { lastTest: { ok: boolean; message: string } | null };
    expect(state.lastTest).toMatchObject({ ok: true, message: "ready" });
    await harness.lifecycle.dispose();
  });

  it("/settings/key/test reports missing without a false-positive when unconfigured", async () => {
    const client = fakeInfisicalClient();
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder", sdk: { hosts: { list: async () => [] } } });
    await plugin(bb, { infisicalClient: client });
    const response = await harness.behavior.fetchHttp("POST", "/settings/key/test", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "jev" }),
    });
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toBe("missing");
    await harness.lifecycle.dispose();
  });
});
