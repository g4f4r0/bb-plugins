import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMcpRequest, redirectGuardFetch, McpGateway, type McpStdioHost } from "../src/gateway.js";
import { McpsStore } from "../src/store.js";
import type { Tool } from "@modelcontextprotocol/client";

function memoryStore() {
  const db = new Database(":memory:");
  return new McpsStore(db, (target, statements) => {
    for (const statement of statements) target.exec(statement);
  });
}

function hostWithTools(tools: Tool[], onCall: () => void): McpStdioHost {
  const catalog = { tools, prompts: [], resources: [], resourceTemplates: [] };
  return {
    async start() { return catalog; },
    async refresh() { return catalog; },
    async close() {},
    async callTool() { onCall(); return { content: [{ type: "text", text: "ok" }] }; },
    async getPrompt() { return {}; },
    async readResource() { return {}; },
    async complete() { return {}; },
    async subscribeResource() {},
    async unsubscribeResource() {},
    async setLoggingLevel() {},
  };
}

function seed(store: McpsStore, id = "echo", name = "Fixture") {
  const now = Date.now();
  store.upsertSource({
    id, name, description: "test server", sourceKind: "manual", sourceRef: "echo",
    registryName: null, registryVersion: null, pluginRoot: "/tmp/mcps-root", pluginData: "/tmp/mcps-data",
    createdAt: now, updatedAt: now,
  });
  store.upsertMcpServer({
    pluginId: id, serverId: "mcp", type: "stdio",
    configJson: JSON.stringify({ type: "stdio", command: "echo", args: [], cwd: "${PLUGIN_DATA}" }),
    status: "ready", lastError: null, approved: 1, enabled: 1,
  });
}

const echoTool = { name: "echo", description: "Echo a message", inputSchema: { type: "object" } } as Tool;
const writeTool = { name: "write_file", description: "Write a file", inputSchema: { type: "object" }, annotations: { destructiveHint: true } } as Tool;
const queryTool = {
  name: "query_data_sources",
  description: "Run a structured lookup",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          query: { type: "string" },
          data_source_urls: { type: "array", items: { type: "string" } },
        },
        required: ["query", "data_source_urls"],
      },
    },
    required: ["data"],
  },
} as Tool;

describe("lazy MCP gateway", () => {
  const gateways: McpGateway[] = [];
  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  });

  it("reports a failed TTL refresh instead of silently returning stale tools", async () => {
    const store = memoryStore(); seed(store);
    const host = hostWithTools([echoTool], () => {});
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host });
    gateways.push(gateway);
    await gateway.inspectServer("echo");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
    host.refresh = async () => { throw new Error("authorization expired"); };
    try {
      const result = await gateway.inspectServer("echo");
      expect(result.error).toContain("authorization expired");
      expect(result.tools).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it("deduplicates concurrent connections and backs off failed servers", async () => {
    const store = memoryStore(); seed(store);
    const host = hostWithTools([echoTool], () => {});
    const start = vi.spyOn(host, "start");
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host });
    gateways.push(gateway);
    await Promise.all(Array.from({length: 30}, () => gateway.inspectServer("echo")));
    expect(start).toHaveBeenCalledTimes(1);
    await gateway.closeServer("echo", "mcp");
    start.mockRejectedValue(new Error("offline"));
    await Promise.all(Array.from({length: 30}, () => gateway.inspectServer("echo")));
    await gateway.inspectServer("echo");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("keeps duplicate names on different servers distinct across catalog eviction", async () => {
    const store = memoryStore();
    for (let i = 0; i < 140; i++) seed(store, `server${i}`);
    const host = hostWithTools([echoTool], () => {});
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host, searchWaitMs: 2000 });
    gateways.push(gateway);
    const result = await gateway.searchTools("echo", 12);
    expect(result.unavailable).toEqual([]);
    expect(new Set(result.tools.map(t => t.opaqueId)).size).toBe(12);
    expect((await gateway.getTool(result.tools[0]!.opaqueId)).name).toBe("echo");
    const state = gateway as unknown as {catalogCache: Map<string, unknown>; catalogIndex: Map<string, unknown>};
    expect(state.catalogCache.size).toBeLessThanOrEqual(128);
    expect(state.catalogIndex.size).toBeLessThanOrEqual(128);
  });

  it("lists 50 servers without connecting and searches 25000 tools", async () => {
    const store = memoryStore();
    for (let i = 0; i < 50; i++) seed(store, `server${i}`);
    const host = hostWithTools(Array.from({length: 500}, (_, i) => ({...echoTool, name: `tool_${i}`})), () => {});
    const start = vi.spyOn(host, "start");
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host, searchWaitMs: 2000 });
    gateways.push(gateway);
    const began = performance.now();
    expect(await gateway.compactServers()).toHaveLength(50);
    const snapshotMs = performance.now() - began;
    expect(start).not.toHaveBeenCalled();
    const cold = performance.now();
    await gateway.searchTools("tool_499");
    const coldMs = performance.now() - cold;
    const warm = performance.now();
    const result = await gateway.searchTools("tool_499");
    const warmMs = performance.now() - warm;
    expect(result.tools).toHaveLength(5);
    expect(start).toHaveBeenCalledTimes(50);
    console.log(JSON.stringify({servers: 50, tools: 25000, snapshotMs, coldMs, warmMs}));
  });

  it("coalesces reconnect bursts until the old transport has closed", async () => {
    const store = memoryStore(); seed(store);
    const host = hostWithTools([echoTool], () => {});
    const start = vi.spyOn(host, "start");
    let release!: () => void;
    host.close = () => new Promise<void>(resolve => { release = resolve; });
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host });
    gateways.push(gateway);
    await gateway.startServer("echo", "mcp");
    const burst = Array.from({length: 20}, () => gateway.reconnectServer("echo", "mcp"));
    await new Promise(resolve => setTimeout(resolve, 10));
    const startsBeforeClose = start.mock.calls.length;
    release();
    await Promise.all(burst);
    host.close = async () => {};
    expect(startsBeforeClose).toBe(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("aborts catalog refresh on disable and survives repeated enable/disable", async () => {
    const store = memoryStore(); seed(store);
    const host = hostWithTools([echoTool], () => {});
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host });
    gateways.push(gateway);
    await gateway.inspectServer("echo");
    let refreshing!: () => void;
    const started = new Promise<void>(resolve => { refreshing = resolve; });
    let aborted = false;
    host.refresh = (_key, signal) => new Promise((_resolve, reject) => {
      refreshing();
      signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, {once: true});
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
    try {
      const read = gateway.inspectServer("echo");
      await started;
      store.setMcpEnabled("echo", "mcp", false);
      await gateway.closeServer("echo", "mcp");
      expect((await read).tools).toEqual([]);
      expect(aborted).toBe(true);
      for (let i = 0; i < 10; i++) {
        store.setMcpEnabled("echo", "mcp", true);
        expect((await gateway.inspectServer("echo")).tools).toHaveLength(1);
        store.setMcpEnabled("echo", "mcp", false);
        await gateway.closeServer("echo", "mcp");
        expect((await gateway.inspectServer("echo")).tools).toEqual([]);
      }
      const state = gateway as unknown as {serverEpochs: Map<string, unknown>; catalogGenerations: Map<string, unknown>};
      expect(state.serverEpochs.size).toBe(0);
      expect(state.catalogGenerations.size).toBe(0);
    } finally { vi.restoreAllMocks(); }
  });

  it("bounds a slow OAuth HTTP request with the existing timeout", async () => {
    vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {once: true});
    }));
    try {
      const fetch = redirectGuardFetch(new URL("https://mcp.example/mcp"), undefined, 20);
      await expect(fetch("https://mcp.example/oauth/token")).rejects.toThrow("timed out");
    } finally { vi.unstubAllGlobals(); }
  });

  it("calls one tool without listing the full catalog", async () => {
    const store = memoryStore();
    seed(store);
    const stdioHost = hostWithTools([echoTool, writeTool], () => {});
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost });
    gateways.push(gateway);
    const listTools = vi.spyOn(gateway, "listTools");
    const { tools: hits } = await gateway.searchTools("echo");
    expect(hits[0]?.name).toBe("echo");
    expect(hits).toHaveLength(1);
    const result = await gateway.call(hits[0]!.opaqueId, {});
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    const schema = await gateway.getTool(hits[0]!.opaqueId);
    expect(schema.inputSchema).toEqual({ type: "object" });
    expect(listTools).not.toHaveBeenCalled();
  });

  it("ranks tools by parameter names and attaches a call card", async () => {
    const store = memoryStore();
    seed(store);
    const stdioHost = hostWithTools([echoTool, queryTool], () => {});
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost });
    gateways.push(gateway);
    const { tools } = await gateway.searchTools("data_source_urls");
    expect(tools[0]?.name).toBe("query_data_sources");
    expect(tools[0]?.card?.shape).toBe("{ data: { query, data_source_urls } }");
    expect(tools[0]?.card?.example).toEqual({ data: { query: "", data_source_urls: [""] } });
  });

  it("compactServers does not connect", async () => {
    const store = memoryStore();
    seed(store);
    const start = vi.fn(async () => ({ tools: [echoTool], prompts: [], resources: [], resourceTemplates: [] }));
    const stdioHost = hostWithTools([echoTool], () => {});
    stdioHost.start = start;
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost });
    gateways.push(gateway);
    const servers = await gateway.compactServers();
    expect(servers).toEqual([expect.objectContaining({ id: "echo", status: "ready", toolCount: null })]);
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments without invoking the tool", async () => {
    const store = memoryStore();
    seed(store);
    let calls = 0;
    const stdioHost = hostWithTools([queryTool], () => { calls += 1; });
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost });
    gateways.push(gateway);
    const { tools } = await gateway.searchTools("query_data_sources");
    await expect(gateway.call(tools[0]!.opaqueId, { query: "today" })).rejects.toThrow(/Invalid arguments/);
    expect(calls).toBe(0);
    expect(gateway.peekTool(tools[0]!.opaqueId)?.name).toBe("query_data_sources");
  });

  it("returns ready catalogs without waiting for a hung server", async () => {
    const store = memoryStore();
    seed(store, "echo", "Echo");
    seed(store, "slow", "Slow");
    const stdioHost: McpStdioHost = {
      async start(config, signal) {
        if (config.key.startsWith("slow:")) {
          await new Promise<never>((_, reject) => {
            const fail = () => reject(new Error("aborted"));
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail, { once: true });
          });
        }
        return { tools: [echoTool], prompts: [], resources: [], resourceTemplates: [] };
      },
      async refresh() { return { tools: [echoTool], prompts: [], resources: [], resourceTemplates: [] }; },
      async close() {},
      async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
      async getPrompt() { return {}; },
      async readResource() { return {}; },
      async complete() { return {}; },
      async subscribeResource() {},
      async unsubscribeResource() {},
      async setLoggingLevel() {},
    };
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost, searchWaitMs: 80 });
    gateways.push(gateway);
    const started = Date.now();
    const result = await gateway.searchTools("echo");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.tools.some((tool) => tool.serverName === "Echo")).toBe(true);
    expect(result.unavailable.some((item) => item.startsWith("Slow"))).toBe(true);
  });
});

describe("MCP header attachment", () => {
  const configured = new URL("https://mcp.example/mcp");
  const jsonrpc = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }) };

  it("keeps configured headers off cross-origin JSON-RPC and event-stream requests", () => {
    expect(isMcpRequest(new URL("https://evil.example/mcp"), configured, configured, jsonrpc)).toBe(false);
    expect(isMcpRequest(
      new URL("https://evil.example/events"),
      configured,
      configured,
      { method: "GET", headers: { accept: "text/event-stream" } },
    )).toBe(false);
    expect(isMcpRequest(configured, configured, configured, jsonrpc)).toBe(true);
  });
});
