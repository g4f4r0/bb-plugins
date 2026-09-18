import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { McpGateway } from "../src/gateway";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("mcps plugin surface", () => {
  it("lists an empty registry over CLI and registers lazy agent tools", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bb-mcps-"));
    temps.push(dataDir);
    const { bb, harness } = createFakePluginHost({
      pluginId: "mcps",
      sdk: {
        system: { config: async () => ({ dataDir, primaryHostId: "host_1" }) },
      },
    });
    await plugin(bb);
    const listed = await harness.behavior.runCli(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("No MCP servers");
    const servers = await harness.behavior.callAgentTool("mcps_servers", {});
    const payload = typeof servers === "string" ? servers : JSON.stringify(servers);
    expect(payload).toContain("[]");
    const added = await harness.behavior.runCli([
      "add", "cloud", "https://mcp.example/mcp",
      "--header", "Authorization: Bearer tok",
    ]);
    expect(added.exitCode).toBe(0);
    const after = await harness.behavior.runCli(["list", "--json"]);
    expect(after.stdout).toContain("streamable-http");
    expect(after.stdout).not.toContain("headers");
    expect(after.stdout).not.toContain("sourceKind");
    const details = await harness.behavior.runCli(["show", "cloud", "--json"]);
    expect(details.stdout).toContain("***");
    expect(details.stdout).toContain("headers");
    const row = JSON.parse(after.stdout!)[0];
    expect(row.id).toMatch(/^mcp_[a-z0-9]{10}$/);
    expect(row.handle).toBe("cloud");
    expect((await harness.behavior.runCli(["show", row.id])).exitCode).toBe(0);
    const alias = await harness.behavior.runCli(["add-http", "legacy", "https://mcp.example/other"]);
    expect(alias.exitCode).toBe(0);
    const help = await harness.behavior.runCli(["--help"]);
    expect(help.stdout).toContain("bb mcps add <name> <url>");
    expect(help.stdout).toContain("bb mcps registry <query>");
    expect(help.stdout).toContain("bb mcps tools <query>");
    expect(help.stdout).toContain("bb mcps show <id>");
    expect(help.stdout).toContain("bb mcps remove <id>");
    expect(help.stdout).not.toContain("add-http");
    expect(help.stdout).not.toContain("bb mcps approve ");
    expect(help.stdout).not.toContain("bb mcps rm ");
    expect(help.stdout).not.toContain("bb mcps find ");
    const shown = await harness.behavior.runCli(["show", "cloud"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("handle: cloud");
    const removed = await harness.behavior.runCli(["remove", "legacy"]);
    expect(removed.exitCode).toBe(0);
    await harness.lifecycle.dispose();
  });
});

it('preserves both concurrent installs with the same name', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bb-mcps-')); temps.push(dataDir);
  const {bb, harness} = createFakePluginHost({pluginId: 'mcps', sdk: {system: {config: async () => ({dataDir, primaryHostId: 'host_1'})}}});
  await plugin(bb);
  try {
    const results = await Promise.all(Array.from({length: 2}, () => harness.behavior.callRpc('addManual', {name: 'same', type: 'stdio', command: 'echo', args: []})));
    expect(results[0]).not.toEqual(results[1]);
    const snapshot = await harness.behavior.callRpc('snapshot', null) as {servers: unknown[]};
    expect(snapshot.servers).toHaveLength(2);
  } finally { await harness.lifecycle.dispose(); }
});


it("exposes descriptive IDs and accepts legacy IDs from existing sessions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-mcps-")); temps.push(dataDir);
  const { bb, harness } = createFakePluginHost({ pluginId: "mcps", sdk: { system: { config: async () => ({ dataDir, primaryHostId: "host_1" }) } } });
  const tool = { opaqueId: "fixture-id", pluginId: "fixture", pluginName: "Fixture", serverId: "mcp", serverType: "stdio", name: "echo", description: "Echo", inputSchema: { type: "object" }, status: "ready" as const };
  vi.spyOn(McpGateway.prototype, "searchTools").mockResolvedValue({ tools: [{ opaqueId: tool.opaqueId, serverId: "mcp", serverName: "Fixture", name: "echo", description: "Echo", risk: "read", enabled: true }], unavailable: [] });
  vi.spyOn(McpGateway.prototype, "getTool").mockResolvedValue(tool);
  const call = vi.spyOn(McpGateway.prototype, "call").mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  vi.spyOn(McpGateway.prototype, "listPrompts").mockResolvedValue([tool]);
  vi.spyOn(McpGateway.prototype, "listResources").mockResolvedValue([{ ...tool, uri: "fixture://data" }]);
  vi.spyOn(McpGateway.prototype, "listResourceTemplates").mockResolvedValue([]);
  const prompt = vi.spyOn(McpGateway.prototype, "getPrompt").mockResolvedValue({ messages: [] });
  const resource = vi.spyOn(McpGateway.prototype, "readResource").mockResolvedValue({ contents: [] });
  await plugin(bb);
  try {
    for (const [name, input, field] of [
      ["mcps_search", { query: "echo" }, "id"],
      ["mcps_prompts", {}, "id"],
      ["mcps_resources", {}, "id"],
    ] as const) {
      const result = JSON.stringify(await harness.behavior.callAgentTool(name, input));
      expect(result).toContain(field);
      expect(result).not.toContain("opaqueId");
    }
    for (const input of [{ id: tool.opaqueId }, { toolId: tool.opaqueId }, { opaqueId: tool.opaqueId }]) {
      const result = JSON.stringify(await harness.behavior.callAgentTool("mcps_schema", input));
      expect(result).toContain("id");
      expect(result).not.toContain("opaqueId");
      await harness.behavior.callAgentTool("mcps_call", input);
    }
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls.every(args => args[0] === tool.opaqueId)).toBe(true);
    for (const input of [{ id: tool.opaqueId }, { promptId: tool.opaqueId }, { opaqueId: tool.opaqueId }]) await harness.behavior.callAgentTool("mcps_get_prompt", input);
    for (const input of [{ id: tool.opaqueId }, { resourceId: tool.opaqueId }, { opaqueId: tool.opaqueId }]) await harness.behavior.callAgentTool("mcps_read_resource", input);
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(resource).toHaveBeenCalledTimes(3);
    await expect(harness.behavior.callAgentTool("mcps_call", {})).rejects.toThrow("id is required");
    const cli = await harness.behavior.runCli(["tools", "echo", "--json"]);
    expect(cli.stdout).toContain("id");
    expect(cli.stdout).not.toContain("opaqueId");
  } finally { await harness.lifecycle.dispose(); vi.restoreAllMocks(); }
});

it("paginates lean discovery, distinguishes unknown counts, and keeps diagnostics opt-in", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-mcps-")); temps.push(dataDir);
  const { bb, harness } = createFakePluginHost({ pluginId: "mcps", sdk: { system: { config: async () => ({ dataDir, primaryHostId: "host_1" }) } } });
  await plugin(bb);
  const unpack = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
  try {
    for (let i = 0; i < 23; i++) await harness.behavior.callRpc("addManual", { name: `server${String(i).padStart(2, "0")}`, type: "stdio", command: "echo" });
    const first = unpack(await harness.behavior.callAgentTool("mcps_servers", {}));
    expect(first.servers).toHaveLength(20); expect(first.nextCursor).toBe(20);
    expect(Object.keys(first.servers[0]).sort()).toEqual(["handle", "id", "status", "type"]);
    const second = unpack(await harness.behavior.callAgentTool("mcps_servers", { cursor: first.nextCursor }));
    expect(second.servers).toHaveLength(3); expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.servers, ...second.servers].map(row => row.id)).size).toBe(23);
    const id = first.servers[0].id;
    const details = unpack(await harness.behavior.callAgentTool("mcps_servers", { query: id, details: true }));
    expect(details.servers).toHaveLength(1); expect(details.servers[0].sourceKind).toBe("manual");
    const snapshot = await harness.behavior.callRpc("snapshot", null) as { servers: Array<{ id: string; handle: string }> };
    expect(snapshot.servers.find(row => row.id === id)?.handle).toBe("server00");
    const compact = vi.spyOn(McpGateway.prototype, "compactServers").mockResolvedValue([{ id: "server00", serverId: "mcp", name: "server00", description: null, type: "stdio", status: "ready", sourceKind: "manual", toolCount: 0, promptCount: 0, resourceCount: 0 }]);
    expect(unpack(await harness.behavior.callAgentTool("mcps_servers", {})).servers[0].tools).toBe(0);
    compact.mockRestore();
  } finally { await harness.lifecycle.dispose(); vi.restoreAllMocks(); }
});

it("uses one input map and preserves full schemas on demand", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-mcps-")); temps.push(dataDir);
  const { bb, harness } = createFakePluginHost({ pluginId: "mcps", sdk: { system: { config: async () => ({ dataDir, primaryHostId: "host_1" }) } } });
  const schema = { type: "object", properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["query"] };
  const { compactToolFromCatalog } = await import("../src/catalog.js");
  const tool = { opaqueId: "mcpt_test123abc", pluginId: "fixture", pluginName: "Fixture", serverId: "mcp", serverType: "stdio", name: "search", description: "Find things", inputSchema: schema, status: "ready" as const, annotations: { readOnlyHint: true } };
  vi.spyOn(McpGateway.prototype, "searchTools").mockResolvedValue({ tools: [compactToolFromCatalog(tool, { card: true })], unavailable: [] });
  vi.spyOn(McpGateway.prototype, "getTool").mockResolvedValue(tool);
  await plugin(bb);
  const unpack = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
  try {
    const result = unpack(await harness.behavior.callAgentTool("mcps_search", { query: "search" }));
    expect(result.tools[0]).toEqual({ id: tool.opaqueId, server: "Fixture", name: "search", description: "Find things", input: { query: "string (minLength=1)", "limit?": "integer (minimum=1)" } });
    expect(result.unavailable).toBeUndefined();
    const full = unpack(await harness.behavior.callAgentTool("mcps_schema", { id: tool.opaqueId }));
    expect(full.inputSchema).toEqual(schema);
    expect(full.card).toBeUndefined();
  } finally { await harness.lifecycle.dispose(); vi.restoreAllMocks(); }
});
