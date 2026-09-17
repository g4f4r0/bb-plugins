import type Database from "better-sqlite3";
import type { McpServerRecord, McpSourceRecord } from "./types.js";

export class McpsStore {
  constructor(
    readonly db: Database.Database,
    migrate: (db: Database.Database, statements: string[]) => void,
  ) {
    try { db.exec("PRAGMA foreign_keys = ON"); } catch {}
    migrate(db, [
      `PRAGMA foreign_keys = ON`,
      `CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        sourceKind TEXT NOT NULL CHECK(sourceKind IN ('manual','registry')),
        sourceRef TEXT,
        registryName TEXT,
        registryVersion TEXT,
        pluginRoot TEXT NOT NULL,
        pluginData TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS mcp_servers (
        pluginId TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        serverId TEXT NOT NULL,
        type TEXT NOT NULL,
        configJson TEXT NOT NULL,
        status TEXT NOT NULL,
        lastError TEXT,
        approved INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (pluginId, serverId)
      )`,
      `CREATE TABLE IF NOT EXISTS tool_policies (
        pluginId TEXT NOT NULL,
        serverId TEXT NOT NULL,
        toolName TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        risk TEXT NOT NULL CHECK(risk IN ('read','write','destructive')),
        mode TEXT NOT NULL CHECK(mode IN ('inherit','allow','deny','confirm')),
        PRIMARY KEY (pluginId, serverId, toolName),
        FOREIGN KEY (pluginId, serverId) REFERENCES mcp_servers(pluginId, serverId) ON DELETE CASCADE
      )`,
      `UPDATE mcp_servers SET approved = 1, status = CASE WHEN status = 'needs-approval' THEN 'idle' ELSE status END WHERE approved != 1`,
    ]);
  }

  listSources(): McpSourceRecord[] {
    return this.db.prepare(`SELECT * FROM sources ORDER BY createdAt DESC`).all() as McpSourceRecord[];
  }

  getPlugin(id: string): McpSourceRecord | undefined {
    return this.db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as McpSourceRecord | undefined;
  }

  getSourceByName(name: string): McpSourceRecord | undefined {
    return this.db.prepare(`SELECT * FROM sources WHERE name = ? COLLATE NOCASE`).get(name) as McpSourceRecord | undefined;
  }

  snapshot(): { sources: McpSourceRecord[]; mcpServers: McpServerRecord[] } {
    return { sources: this.listSources(), mcpServers: this.listMcpServers() };
  }

  upsertSource(record: McpSourceRecord): void {
    this.db.prepare(
      `INSERT INTO sources (id, name, description, sourceKind, sourceRef, registryName, registryVersion, pluginRoot, pluginData, createdAt, updatedAt)
       VALUES (@id, @name, @description, @sourceKind, @sourceRef, @registryName, @registryVersion, @pluginRoot, @pluginData, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, description=excluded.description, sourceKind=excluded.sourceKind,
         sourceRef=excluded.sourceRef, registryName=excluded.registryName, registryVersion=excluded.registryVersion,
         pluginRoot=excluded.pluginRoot, pluginData=excluded.pluginData, updatedAt=excluded.updatedAt`,
    ).run(record as unknown as Record<string, unknown>);
  }

  deleteSource(id: string): boolean {
    return this.db.prepare(`DELETE FROM sources WHERE id = ?`).run(id).changes > 0;
  }

  listMcpServers(pluginId?: string): McpServerRecord[] {
    if (pluginId) {
      return this.db.prepare(`SELECT * FROM mcp_servers WHERE pluginId = ?`).all(pluginId) as McpServerRecord[];
    }
    return this.db.prepare(`SELECT * FROM mcp_servers`).all() as McpServerRecord[];
  }

  getServer(pluginId: string, serverId: string): McpServerRecord | undefined {
    return this.db.prepare(`SELECT * FROM mcp_servers WHERE pluginId = ? AND serverId = ?`).get(pluginId, serverId) as McpServerRecord | undefined;
  }

  resolveSource(idOrName: string): McpSourceRecord | undefined {
    return this.getPlugin(idOrName) ?? this.getSourceByName(idOrName);
  }

  deleteMcpServer(pluginId: string, serverId: string): boolean {
    return this.db.prepare(`DELETE FROM mcp_servers WHERE pluginId = ? AND serverId = ?`).run(pluginId, serverId).changes > 0;
  }

  /** Adding a server is consent; lift leftover Agent Plugins-style gates. */
  admitPending(): number {
    const pending = this.listMcpServers().filter((record) => record.approved !== 1);
    for (const server of pending) {
      this.upsertMcpServer({
        ...server,
        approved: 1,
        status: server.status === "needs-approval" ? "idle" : server.status,
      });
    }
    return pending.length;
  }

  upsertMcpServer(record: McpServerRecord): void {
    this.db.prepare(
      `INSERT INTO mcp_servers (pluginId, serverId, type, configJson, status, lastError, approved, enabled)
       VALUES (@pluginId, @serverId, @type, @configJson, @status, @lastError, @approved, @enabled)
       ON CONFLICT(pluginId, serverId) DO UPDATE SET
         type=excluded.type, configJson=excluded.configJson, status=excluded.status,
         lastError=excluded.lastError, approved=excluded.approved, enabled=excluded.enabled`,
    ).run(record as unknown as Record<string, unknown>);
  }

  setMcpEnabled(pluginId: string, serverId: string, enabled: boolean): McpServerRecord | undefined {
    this.db.prepare(`UPDATE mcp_servers SET enabled = ? WHERE pluginId = ? AND serverId = ?`).run(enabled ? 1 : 0, pluginId, serverId);
    return this.getServer(pluginId, serverId);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
