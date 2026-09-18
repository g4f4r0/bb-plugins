import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { McpsStore } from "../src/store.js";
import { McpGateway } from "../src/gateway.js";
import { createHash } from "node:crypto";

const source = { id: "notion", name: "Notion", description: null, sourceKind: "manual" as const, sourceRef: null, registryName: null, registryVersion: null, pluginRoot: "/tmp", pluginData: "/tmp", createdAt: 0, updatedAt: 0 };
const server = { pluginId: "notion", serverId: "mcp", type: "stdio" as const, configJson: '{"type":"stdio","command":"echo"}', status: "idle" as const, lastError: null, approved: 1, enabled: 1 };
const migrate = (db: Database.Database, statements: string[]) => statements.forEach(s => db.exec(s));

it("backfills stable public IDs while preserving legacy storage, policy and credential keys", () => {
  const db = new Database(":memory:");
  let store = new McpsStore(db, migrate);
  store.upsertSource(source); store.upsertMcpServer(server);
  db.prepare("INSERT INTO tool_policies VALUES (?, ?, ?, 1, 'read', 'inherit')").run("notion", "mcp", "echo");
  // Recreate the pre-migration database, including the original storage keys.
  db.exec("DROP TABLE source_identities");
  store = new McpsStore(db, migrate);
  const identity = store.identity("notion");
  expect(identity).toEqual({ id: expect.stringMatching(/^mcp_[a-z0-9]{10}$/), handle: "notion" });
  expect(store.resolveSource(identity.id)).toEqual(source);
  expect(store.resolveSource("notion")).toEqual(source);
  expect(store.listMcpServers()).toEqual([server]);
  expect(db.prepare("SELECT pluginId, serverId FROM tool_policies").get()).toEqual({ pluginId: "notion", serverId: "mcp" });
  store = new McpsStore(db, migrate);
  store.upsertSource({ ...source, name: "Renamed Notion" });
  expect(store.identity("notion")).toEqual(identity);
  expect(store.resolveSource(identity.id)?.name).toBe("Renamed Notion");
  store.deleteSource("notion"); store.upsertSource(source);
  expect(store.identity("notion").id).not.toBe(identity.id);
  db.close();
});

it("resolves saved capability IDs, keeps new IDs stable on reload, and scopes discovery", async () => {
  const db = new Database(":memory:");
  const store = new McpsStore(db, migrate);
  store.upsertSource(source); store.upsertMcpServer(server);
  store.upsertSource({ ...source, id: "offline", name: "Offline" });
  store.upsertMcpServer({ ...server, pluginId: "offline" });
  const started: string[] = [];
  const catalog = { tools: [{ name: "echo", inputSchema: { type: "object" as const } }], prompts: [], resources: [], resourceTemplates: [] };
  const host = {
    async start(input: { key: string }) { started.push(input.key); if (input.key.startsWith("offline")) throw new Error("offline"); return catalog; },
    async refresh() { return catalog; }, async close() {},
    async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
    async getPrompt() { return {}; }, async readResource() { return {}; }, async complete() { return {}; },
    async subscribeResource() {}, async unsubscribeResource() {}, async setLoggingLevel() {},
  };
  const createGateway = () => new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host });
  let gateway = createGateway();
  try {
    const identity = store.identity("notion");
    const result = await gateway.searchTools("echo", 5, identity.id);
    const id = result.tools[0]!.opaqueId;
    expect(id).toMatch(/^mcpt_[a-z0-9]{10}$/);
    expect(started).toEqual(["notion:mcp"]);
    expect(result.unavailable).toEqual([]);
    expect((await gateway.searchTools("echo", 5, "notion")).tools[0]?.opaqueId).toBe(id);
    const oldId = "notion__mcp__echo_" + createHash("sha256").update(JSON.stringify(["notion", "mcp", "echo"])).digest("hex").slice(0, 10);
    expect((await gateway.call(oldId, {})).content[0]?.text).toBe("ok");
    await gateway.close(); gateway = createGateway();
    expect((await gateway.searchTools("echo", 5, "notion")).tools[0]?.opaqueId).toBe(id);
    await gateway.close(); store.deleteSource("notion"); store.upsertSource(source); store.upsertMcpServer(server); gateway = createGateway();
    expect((await gateway.searchTools("echo", 5, "notion")).tools[0]?.opaqueId).not.toBe(id);
    await expect(gateway.searchTools("echo", 5, "missing")).rejects.toThrow("not found");
  } finally { await gateway.close(); db.close(); }
});
