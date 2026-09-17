import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

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
