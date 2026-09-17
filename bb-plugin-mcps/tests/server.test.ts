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
    expect(after.stdout).toContain("headers");
    expect(after.stdout).toContain("***");
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
    expect(shown.stdout).toContain("id: cloud");
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
      ["mcps_search", { query: "echo" }, "toolId"],
      ["mcps_prompts", {}, "promptId"],
      ["mcps_resources", {}, "resourceId"],
    ] as const) {
      const result = JSON.stringify(await harness.behavior.callAgentTool(name, input));
      expect(result).toContain(field);
      expect(result).not.toContain("opaqueId");
    }
    for (const input of [{ toolId: tool.opaqueId }, { opaqueId: tool.opaqueId }]) {
      const result = JSON.stringify(await harness.behavior.callAgentTool("mcps_schema", input));
      expect(result).toContain("toolId");
      expect(result).not.toContain("opaqueId");
      await harness.behavior.callAgentTool("mcps_call", input);
    }
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.every(args => args[0] === tool.opaqueId)).toBe(true);
    for (const input of [{ promptId: tool.opaqueId }, { opaqueId: tool.opaqueId }]) await harness.behavior.callAgentTool("mcps_get_prompt", input);
    for (const input of [{ resourceId: tool.opaqueId }, { opaqueId: tool.opaqueId }]) await harness.behavior.callAgentTool("mcps_read_resource", input);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(resource).toHaveBeenCalledTimes(2);
    await expect(harness.behavior.callAgentTool("mcps_call", {})).rejects.toThrow("toolId is required");
    const cli = await harness.behavior.runCli(["tools", "echo", "--json"]);
    expect(cli.stdout).toContain("toolId");
    expect(cli.stdout).not.toContain("opaqueId");
  } finally { await harness.lifecycle.dispose(); vi.restoreAllMocks(); }
});
