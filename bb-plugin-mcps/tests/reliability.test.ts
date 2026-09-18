import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpGateway } from "../src/gateway.js";
import { McpsStore } from "../src/store.js";
import { DeferredOAuthCredentialStore, McpOAuthProvider, type OAuthCredentialRecord } from "../src/oauth.js";

const origin = "https://fixture.example";
const redirect = new URL("https://bb.example/callback");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

async function fixture() {
  const db = new Database(":memory:");
  const store = new McpsStore(db, (target, statements) => statements.forEach(s => target.exec(s)));
  store.upsertSource({ id: "fixture", name: "Fixture", description: null, sourceKind: "manual", sourceRef: null, registryName: null, registryVersion: null, pluginRoot: "/tmp", pluginData: "/tmp", createdAt: 0, updatedAt: 0 });
  store.upsertMcpServer({ pluginId: "fixture", serverId: "mcp", type: "streamable-http", configJson: JSON.stringify({ type: "streamable-http", url: `${origin}/mcp` }), status: "idle", lastError: null, approved: 1, enabled: 1 });
  let durable: Record<string, OAuthCredentialRecord> = { "fixture:mcp": {
    redirectUri: redirect.toString(),
    clientInformation: { client_id: "fixture-client", issuer: origin },
    tokens: { access_token: "access-0", refresh_token: "refresh-0", token_type: "Bearer", issuer: origin },
  } };
  const secrets = new DeferredOAuthCredentialStore({ async load() { return durable; }, async save(value) { durable = structuredClone(value); } });
  const state = { generation: 0, expired: false, refreshes: 0, tokenFailure: false, calls: 0, listFailure: false, delay401: false, sessionExpired: false, handshakes: 0 };
  const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.includes(".well-known/oauth-protected-resource")) return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname.includes(".well-known/")) return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.pathname === "/token") {
      state.refreshes++;
      await new Promise(resolve => setTimeout(resolve, 10));
      if (state.tokenFailure) return json({ error: "server_error" }, 503);
      const params = new URLSearchParams(String(init?.body));
      if (params.get("refresh_token") !== `refresh-${state.generation}`) return json({ error: "invalid_grant" }, 400);
      state.generation++; state.expired = false;
      return json({ access_token: `access-${state.generation}`, refresh_token: `refresh-${state.generation}`, token_type: "Bearer" });
    }
    if (url.pathname !== "/mcp") throw new Error(`Unexpected fixture path: ${url.pathname}`);
    const token = new Headers(init?.headers).get("authorization");
    if (state.expired || token !== `Bearer access-${state.generation}`) {
      if (state.delay401) await new Promise(resolve => setTimeout(resolve, state.calls++ % 2 ? 50 : 0));
      return json({}, 401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
    }
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body));
    if (state.sessionExpired && new Headers(init?.headers).has("mcp-session-id")) return json({}, 404);
    if (request.id === undefined) return new Response(null, { status: 202 });
    if (request.method === "server/discover") return json({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    else if (request.method === "tools/list") {
      if (state.listFailure) return json({}, 503);
      result = request.params?.cursor ? { tools: [{ name: "second", inputSchema: { type: "object" } }] } : { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "page2" };
    } else if (request.method === "tools/call") result = { content: [{ type: "text", text: "fixture-ok" }] };
    else throw new Error(`Unexpected method: ${request.method}`);
    if (request.method === "initialize") { state.sessionExpired = false; state.handshakes++; }
    return json({ jsonrpc: "2.0", id: request.id, result }, 200, request.method === "initialize" ? { "mcp-session-id": `session-${state.handshakes}` } : {});
  }));
  const createGateway = (credentials = secrets) => new McpGateway(store, { info() {}, warn() {}, error() {} }, {
    oauth: { async getProvider() { return new McpOAuthProvider("fixture:mcp", new URL(`${origin}/mcp`), redirect, credentials); } },
  });
  const gateway = createGateway();
  cleanups.push(async () => { await gateway.close(); db.close(); });
  return { gateway, state, secrets, store, createGateway, durable: () => durable };
}

describe("MCP reliability under contention and expiry", () => {
  it("preserves all fields under 100 concurrent credential updates across provider instances", async () => {
    const secrets = new DeferredOAuthCredentialStore({ async load() { return {}; }, async save() {} });
    const a = new McpOAuthProvider("fixture:mcp", new URL(origin), redirect, secrets);
    const b = new McpOAuthProvider("fixture:mcp", new URL(origin), redirect, secrets);
    await Promise.all(Array.from({ length: 100 }, (_, i) => i % 2 ? a.saveTokens({ access_token: `token-${i}`, token_type: "Bearer" }) : b.saveCodeVerifier(`verifier-${i}`)));
    expect(await a.tokens()).toMatchObject({ access_token: "token-99" });
    expect(await b.codeVerifier()).toBe("verifier-98");
  });

  it("coalesces cold credential reads so a late load cannot overwrite a write", async () => {
    let loads = 0;
    const secrets = new DeferredOAuthCredentialStore({ async load() { loads++; await new Promise(resolve => setTimeout(resolve, 5)); return {}; }, async save() {} });
    await Promise.all([...Array.from({ length: 40 }, () => secrets.get("fixture:mcp")), secrets.set("fixture:mcp", { codeVerifier: "new" })]);
    expect(loads).toBe(1);
    expect(await secrets.get("fixture:mcp")).toEqual({ codeVerifier: "new" });
  });

  it("retries a failed deferred secret write without another user operation", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValueOnce(new Error("temporary settings failure")).mockResolvedValue(undefined);
    const secrets = new DeferredOAuthCredentialStore({ async load() { return {}; }, save });
    const release = secrets.deferPersistence();
    await secrets.set("fixture:mcp", { codeVerifier: "durable" }); release();
    await vi.advanceTimersByTimeAsync(1100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ "fixture:mcp": { codeVerifier: "durable" } });
  });

  it("survives 5 expiry waves of 40 concurrent calls, delayed 401s, pagination and reload", async () => {
    const { gateway, state, createGateway, secrets, durable } = await fixture();
    const search = await gateway.searchTools("echo");
    expect(search.unavailable).toEqual([]);
    const id = search.tools[0]!.opaqueId;
    expect((await gateway.inspectServer("fixture")).tools).toHaveLength(2);
    for (let wave = 0; wave < 5; wave++) {
      state.expired = true; state.delay401 = true;
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => gateway.call(id, { i })));
      expect(results.every(result => result.content[0]?.text === "fixture-ok")).toBe(true);
      expect(state.refreshes).toBe(wave + 1);
      expect((await secrets.get("fixture:mcp"))?.tokens?.refresh_token).toBe(`refresh-${wave + 1}`);
    }
    await gateway.close();
    const restartedSecrets = new DeferredOAuthCredentialStore({ async load() { return structuredClone(durable()); }, async save() {} });
    const reloaded = createGateway(restartedSecrets);
    try { expect((await reloaded.searchTools("echo")).tools[0]?.opaqueId).toBe(id); }
    finally { await reloaded.close(); }
    expect(state.refreshes).toBe(5);
  });

  it("keeps refresh credentials on token endpoint outage and recovers on the next call", async () => {
    const { gateway, state, secrets } = await fixture();
    const id = (await gateway.searchTools("echo")).tools[0]!.opaqueId;
    state.expired = true; state.tokenFailure = true;
    await expect(gateway.call(id, {})).rejects.toThrow("temporarily unavailable");
    expect((await secrets.get("fixture:mcp"))?.tokens?.refresh_token).toBe("refresh-0");
    expect((await secrets.get("fixture:mcp"))?.authorizationUrl).toBeUndefined();
    expect(await gateway.authStatus("fixture", "mcp")).toBe("authenticated");
    state.tokenFailure = false;
    expect((await gateway.call(id, {})).content[0]?.text).toBe("fixture-ok");
  });

  it("still exposes a consent URL when credentials really are missing", async () => {
    const { gateway, secrets } = await fixture();
    const record = (await secrets.get("fixture:mcp"))!;
    delete record.tokens;
    await secrets.set("fixture:mcp", record);
    const searches = await Promise.all(Array.from({ length: 20 }, () => gateway.searchTools("echo")));
    expect(searches.every(result => result.tools.length === 0 && result.unavailable.length === 1)).toBe(true);
    expect((await gateway.compactServers())[0]?.status).toBe("needs-auth");
    expect(await gateway.authUrl("fixture", "mcp")).toContain(`${origin}/authorize`);
    expect(await gateway.authStatus("fixture", "mcp")).toBe("authorizing");
  });

  it("reconnects expired sessions on the next call without replaying the failed tool", async () => {
    const { gateway, state } = await fixture();
    const id = (await gateway.searchTools("echo")).tools[0]!.opaqueId;
    state.sessionExpired = true;
    await expect(gateway.call(id, {})).rejects.toThrow("session expired");
    expect(state.handshakes).toBe(1);
    expect((await gateway.call(id, {})).content[0]?.text).toBe("fixture-ok");
    expect(state.handshakes).toBe(2);
    expect(state.refreshes).toBe(0);
  });

  it("reports catalog outages accurately, then restores discovery after backoff", async () => {
    const { gateway, state } = await fixture();
    await gateway.searchTools("echo");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 300001);
    state.listFailure = true;
    const failed = await gateway.searchTools("echo");
    expect(failed.tools).toEqual([]); expect(failed.unavailable).toHaveLength(1);
    expect((await gateway.compactServers())[0]?.status).toBe("error");
    state.listFailure = false;
    vi.mocked(Date.now).mockReturnValue(now + 306000);
    expect((await gateway.searchTools("echo")).tools).toHaveLength(1);
    expect((await gateway.compactServers())[0]?.status).toBe("ready");
  });
});
