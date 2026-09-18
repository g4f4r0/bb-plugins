import { LruMap } from "./src/lru.js";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { McpsStore } from "./src/store.js";
import { McpGateway, slug, type McpStdioCatalog, type McpStdioHost } from "./src/gateway.js";
import { mcpHostContract, mcpHostSignals } from "./src/host-contract.js";
import { DeferredOAuthCredentialStore, McpOAuthProvider, type OAuthCredentialRecord } from "./src/oauth.js";
import { oauthRedirectBase, serverAccessPublicUrl, serverAppUrl } from "./src/oauth-redirect.js";
import { parseHeaderLines, validateMcpServer } from "./src/loader.js";
import { ensureDir, rimraf } from "./src/safe-fs.js";
import { boundText, boundJson, formatMcpResult, SCHEMA_INLINE_CHARS, scoreMatch, SEARCH_LIMIT, SEARCH_MAX, writeArtifact } from "./src/catalog.js";
import { validateCallArgs } from "./src/call-card.js";
import { classifyTool } from "./src/policy.js";
import { fetchRegistryServers, normalizeRegistryServer, OFFICIAL_REGISTRY, type RegistryServerSummary } from "./src/registry.js";
import type { JsonRecord, McpServerType, McpSourceKind } from "./src/types.js";

const jsonRecordSchema = z.record(z.string(), z.unknown());
const sourceIdSchema = z.string().min(1).max(128);

const compactServerSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  sourceKind: z.string(),
  approved: z.boolean(),
  enabled: z.boolean(),
  authStatus: z.string(),
  lastError: z.string().nullable(),
  sourceRef: z.string().nullable(),
  registryName: z.string().nullable(),
  registryVersion: z.string().nullable(),
  configJson: z.string(),
  toolCount: z.number().int().nullable(),
  promptCount: z.number().int().nullable(),
  resourceCount: z.number().int().nullable(),
}).strict();

const registryHitSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  status: z.string(),
  installable: z.boolean(),
  sourceRef: z.string().nullable(),
  type: z.string().nullable(),
  remote: z.boolean(),
  requiredHeaders: z.array(z.string()),
}).strict();

const compactToolSchema = z.object({
  schemaRequired: z.boolean().optional(),
  pluginId: z.string().optional(),
  opaqueId: z.string(),
  serverId: z.string(),
  serverName: z.string(),
  name: z.string(),
  description: z.string(),
  risk: z.enum(["read", "write", "destructive"]),
  enabled: z.boolean(),
  card: z.object({
    truncated: z.boolean().optional(),
    shape: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
      enum: z.array(z.string()).optional(),
    })),
    example: jsonRecordSchema,
  }).optional(),
}).strict();

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: z.object({ servers: z.array(compactServerSchema) }).strict() },
  registrySearch: {
    input: z.object({
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(30).optional(),
      remoteOnly: z.boolean().optional(),
      cursor: z.string().max(2000).optional(),
    }).strict(),
    output: z.object({ servers: z.array(registryHitSchema), nextCursor: z.string().nullable() }).strict(),
  },
  addFromRegistry: {
    input: z.object({
      name: z.string().min(1).max(200),
      headers: z.record(z.string(), z.string()).optional(),
      headerLines: z.array(z.string().max(4096)).max(32).optional(),
    }).strict(),
    output: z.object({ id: z.string(), handle: z.string(), name: z.string() }).strict(),
  },
  addManual: {
    input: z.object({
      name: z.string().trim().min(1).max(120),
      type: z.enum(["stdio", "streamable-http", "sse"]),
      command: z.string().max(1024).optional(),
      args: z.array(z.string().max(1024)).max(64).optional(),
      cwd: z.string().max(16_384).optional(),
      url: z.string().max(2048).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      headerLines: z.array(z.string().max(4096)).max(32).optional(),
    }).strict(),
    output: z.object({ id: z.string(), handle: z.string(), name: z.string() }).strict(),
  },
  remove: { input: z.object({ id: sourceIdSchema }).strict(), output: z.object({ deleted: z.boolean() }).strict() },
  approve: { input: z.object({ id: sourceIdSchema }).strict(), output: z.object({ approved: z.boolean() }).strict() },
  setEnabled: { input: z.object({ id: sourceIdSchema, enabled: z.boolean() }).strict(), output: z.object({ enabled: z.boolean(), status: z.string() }).strict() },
  setHeaders: {
    input: z.object({
      id: sourceIdSchema,
      headers: z.record(z.string(), z.string()).optional(),
      headerLines: z.array(z.string().max(4096)).max(32).optional(),
    }).strict(),
    output: z.object({ updated: z.boolean() }).strict(),
  },
  authenticate: { input: z.object({ id: sourceIdSchema }).strict(), output: z.object({ url: z.string().nullable(), status: z.string() }).strict() },
  reconnect: { input: z.object({ id: sourceIdSchema }).strict(), output: z.object({ url: z.string().nullable(), status: z.string() }).strict() },
  finishAuthentication: { input: z.object({ id: sourceIdSchema, callbackUrl: z.string().url() }).strict(), output: z.object({ authenticated: z.boolean() }).strict() },
  cancelAuthentication: { input: z.object({ id: sourceIdSchema }).strict(), output: z.object({ canceled: z.boolean() }).strict() },
  searchTools: {
    input: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(12).optional() }).strict(),
    output: z.object({ tools: z.array(compactToolSchema), unavailable: z.array(z.string()) }).strict(),
  },
  inspectServer: {
    input: z.object({ id: sourceIdSchema }).strict(),
    output: z.object({ tools: z.array(compactToolSchema), error: z.string().nullable() }).strict(),
  },
});

function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function redactMcpConfigJson(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const redacted: Record<string, unknown> = { ...obj };
    if (obj.headers && typeof obj.headers === "object") {
      const headers: Record<string, string> = {};
      for (const key of Object.keys(obj.headers as Record<string, unknown>)) headers[key] = "***";
      redacted.headers = headers;
    }
    if (obj.env && typeof obj.env === "object") {
      const env: Record<string, string> = {};
      for (const key of Object.keys(obj.env as Record<string, unknown>)) env[key] = "***";
      redacted.env = env;
    }
    return JSON.stringify(redacted);
  } catch {
    return raw;
  }
}

function registryHit(summary: RegistryServerSummary) {
  const install = normalizeRegistryServer(summary);
  const remote = summary.remotes.find((item) => item.type === "streamable-http" || item.type === "sse" || item.url.startsWith("http"));
  return {
    name: summary.name,
    description: summary.description,
    version: summary.version,
    status: summary.status,
    installable: install !== null,
    sourceRef: install?.sourceRef ?? null,
    type: install?.type ?? null,
    remote: Boolean(remote),
    requiredHeaders: (remote?.headers ?? []).filter((header) => header.isRequired).map((header) => header.name),
  };
}

function headersFromInput(headers?: Record<string, string>, headerLines?: string[]): Record<string, string> | undefined {
  const parsed = headerLines ? parseHeaderLines(headerLines) : {};
  const merged = { ...parsed, ...(headers ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("[mcps] loading");

  let dataDir: string | null = null;
  const getDataDir = async (): Promise<string> => {
    if (dataDir) return dataDir;
    const cfg = await bb.sdk.system.config() as unknown as { dataDir?: string };
    if (typeof cfg.dataDir === "string" && cfg.dataDir) {
      dataDir = cfg.dataDir;
      return cfg.dataDir;
    }
    throw new Error("dataDir unavailable");
  };

  async function publishChanged(payload: Record<string, unknown>): Promise<void> {
    try { await bb.realtime.publish("mcps-changed", payload); }
    catch (error) { bb.log.warn(`[mcps] realtime publish failed: ${errorText(error)}`); }
  }

  const store = new McpsStore(bb.storage.database(), (db, statements) => bb.storage.migrate(db, statements));
  store.admitPending();
  const settings = bb.settings.define({
    registryUrl: {
      type: "string",
      label: "MCP Registry URL",
      description: "Official or private MCP Registry base URL.",
      default: OFFICIAL_REGISTRY,
    },
    oauthCredentials: {
      type: "string",
      label: "MCP OAuth credentials",
      description: "Managed automatically by MCPs; stored as a BB secret.",
      secret: true,
      default: "",
    },
    oauthRedirectBaseUrl: {
      type: "string",
      label: "OAuth redirect base URL",
      description: "Public origin for MCP OAuth callbacks when the browser is not on this server. Empty uses BB_APP_URL, then this instance's public Connect URL, then loopback.",
      default: "",
    },
  });
  const oauthCredentialStore = new DeferredOAuthCredentialStore({
    async load(): Promise<Record<string, OAuthCredentialRecord>> {
      const raw = (await settings.get()).oauthCredentials;
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, OAuthCredentialRecord>;
      } catch (error) { bb.log.warn(`[mcps] OAuth secret store is invalid: ${errorText(error)}`); }
      return {};
    },
    async save(next: Record<string, OAuthCredentialRecord>): Promise<void> {
      await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { oauthCredentials: JSON.stringify(next) } });
    },
  }, (error) => bb.log.warn(`[mcps] OAuth secret persistence failed: ${errorText(error)}`));
  async function withDeferredOAuthPersistence<T>(operation: () => Promise<T>): Promise<T> {
    const release = oauthCredentialStore.deferPersistence();
    try { return await operation(); }
    finally { release(); }
  }
  async function deleteOAuthCredentials(pluginId: string, serverId: string): Promise<void> {
    await oauthCredentialStore.delete(`${pluginId}:${serverId}`).catch((error) => {
      throw new Error(`Could not delete OAuth credentials for ${pluginId}:${serverId}: ${errorText(error)}`, { cause: error });
    });
  }

  const mcpHostClient = bb.hosts.experimental_client({
    contract: mcpHostContract,
    experimental_signals: mcpHostSignals,
  });
  let mcpHostIdPromise: Promise<string> | null = null;
  async function getMcpHostId(): Promise<string> {
    if (mcpHostIdPromise) return mcpHostIdPromise;
    mcpHostIdPromise = (async () => {
      const cfg = await bb.sdk.system.config() as unknown as { primaryHostId?: string | null };
      if (cfg.primaryHostId) return cfg.primaryHostId;
      const hosts = await bb.sdk.hosts.list();
      const hostId = hosts[0]?.id;
      if (!hostId) throw new Error("No host available for isolated MCP servers");
      return hostId;
    })().catch((error) => {
      mcpHostIdPromise = null;
      throw error;
    });
    return mcpHostIdPromise;
  }
  const hostCall = async (method: string, input: unknown, signal?: AbortSignal): Promise<unknown> => {
    const hostId = await getMcpHostId();
    const client = mcpHostClient as unknown as {
      call(name: string, value: unknown, options: { hostId: string; signal?: AbortSignal }): Promise<unknown>;
    };
    return client.call(method, input, { hostId, ...(signal ? { signal } : {}) });
  };
  const stdioHost: McpStdioHost = {
    async start(config, signal) { return await hostCall("start", config, signal) as McpStdioCatalog; },
    async refresh(key, signal) { return await hostCall("refresh", { key }, signal) as McpStdioCatalog; },
    async close(key, signal) { await hostCall("close", { key }, signal); },
    async callTool(key, name, args, toolDefinition, signal) {
      return hostCall("callTool", { key, name, args, ...(toolDefinition ? { toolDefinition } : {}) }, signal);
    },
    async getPrompt(key, name, args, signal) { return hostCall("getPrompt", { key, name, args }, signal); },
    async readResource(key, uri, signal) { return hostCall("readResource", { key, uri }, signal); },
    async complete(key, ref, argument, signal) { return hostCall("complete", { key, ref, argument }, signal); },
    async subscribeResource(key, uri, signal) { await hostCall("subscribeResource", { key, uri }, signal); },
    async unsubscribeResource(key, uri, signal) { await hostCall("unsubscribeResource", { key, uri }, signal); },
    async setLoggingLevel(key, level, signal) { await hostCall("setLoggingLevel", { key, level }, signal); },
    onWorkerExit(handler) {
      return mcpHostClient.experimental_onWorkerExit(({ hostId }) => handler(hostId));
    },
    onCatalogChanged(handler) {
      return mcpHostClient.experimental_onSignal("catalogChanged", ({ payload }) => handler(payload.key, payload.kind, payload.error));
    },
    onConnectionChanged(handler) {
      return mcpHostClient.experimental_onSignal("connectionChanged", ({ payload }) => handler(payload.key, payload.status, payload.error));
    },
  };
  const gateway = new McpGateway(store, bb.log, {
    onChanged: () => publishChanged({ kind: "mcp-runtime" }),
    stdioHost,
    oauth: {
      async getProvider(pluginId, serverId, serverUrl) {
        const current = await settings.get();
        let publicUrl: string | null = null;
        try { publicUrl = serverAccessPublicUrl(await bb.sdk.system.config()); } catch { /* isolated harnesses may not bind sdk */ }
        const base = oauthRedirectBase({
          setting: current.oauthRedirectBaseUrl,
          appUrl: serverAppUrl(bb.server),
          publicUrl,
          loopbackBaseUrl: bb.server.loopbackBaseUrl,
        });
        const redirect = new URL(`/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http/oauth/callback`, base);
        redirect.search = new URLSearchParams({ pluginId, serverId }).toString();
        return new McpOAuthProvider(`${pluginId}:${serverId}`, serverUrl, redirect, oauthCredentialStore);
      },
    },
  });

  async function artifactDir(): Promise<string> {
    const dir = path.join(await getDataDir(), "plugins", "mcps", "artifacts");
    await ensureDir(dir);
    return dir;
  }
  async function agentReply(value: unknown, name: string, maxChars = 8_000) {
    const formatted = formatMcpResult(value);
    const text = await boundText(formatted.text, { artifactDir: await artifactDir(), name, maxChars });
    return { content: [{ type: "text" as const, text }], ...(formatted.isError ? { isError: true as const } : {}) };
  }

  async function agentData(value: unknown, name: string) {
    const result = await boundJson(value, { artifactDir: await artifactDir(), name, maxChars: 8_000 });
    return { content: [{ type: "text" as const, text: result.json }] };
  }

  function sourceDirs(id: string, dd: string) {
    const root = path.join(dd, "plugins", "mcps", "servers", id);
    return { pluginRoot: path.join(root, "root"), pluginData: path.join(root, "data") };
  }

  const reservedSourceIds = new Set<string>();

  async function addServer(input: {
    name: string;
    description?: string;
    sourceKind: McpSourceKind;
    sourceRef?: string;
    registryName?: string;
    registryVersion?: string;
    type: McpServerType;
    config: Record<string, unknown>;
  }) {
    const validation = validateMcpServer("mcp", input.config);
    if (!validation.valid || !validation.config) throw new Error(validation.errors.join("; "));
    const dd = await getDataDir();
    const base = slug(input.name).slice(0, 40);
    let id = base;
    while (store.resolveSource(id) || reservedSourceIds.has(id)) id = `${base}_${crypto.randomBytes(3).toString("hex")}`;
    const dirs = sourceDirs(id, dd);
    // Reserve the ID synchronously before the first filesystem await.
    reservedSourceIds.add(id);
    try {
      await ensureDir(dirs.pluginRoot);
      await ensureDir(dirs.pluginData);
      const now = Date.now();
      store.transaction(() => {
        store.upsertSource({
          id,
          name: input.name,
          description: input.description ?? null,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef ?? null,
          registryName: input.registryName ?? null,
          registryVersion: input.registryVersion ?? null,
          pluginRoot: dirs.pluginRoot,
          pluginData: dirs.pluginData,
          createdAt: now,
          updatedAt: now,
        });
        store.upsertMcpServer({
          pluginId: id,
          serverId: "mcp",
          type: input.type,
          configJson: JSON.stringify(validation.config),
          status: "idle",
          lastError: null,
          approved: 1,
          enabled: 1,
        });
      });
    } finally { reservedSourceIds.delete(id); }
    await publishChanged({ kind: "add", id });
    return { ...store.identity(id), name: input.name };
  }

  async function requireSource(id: string) {
    const source = store.resolveSource(id);
    if (!source) throw new Error(`not found: ${id}`);
    const server = store.getServer(source.id, "mcp");
    if (!server) throw new Error(`MCP server missing for ${source.id}`);
    return { source, server };
  }

  async function buildSnapshot() {
    const compact = await gateway.compactServers();
    const servers = await Promise.all(compact.map(async (item) => {
      const source = store.getPlugin(item.id);
      const server = store.getServer(item.id, item.serverId);
      let authStatus = "not-applicable";
      if (server && server.type !== "stdio") {
        try { authStatus = await gateway.authStatus(item.id, item.serverId); }
        catch { authStatus = "unknown"; }
      }
      return {
        ...store.identity(item.id),
        name: item.name, description: item.description, type: item.type, status: item.status,
        sourceKind: item.sourceKind, toolCount: item.toolCount, promptCount: item.promptCount, resourceCount: item.resourceCount,
        approved: server?.approved === 1,
        enabled: server?.enabled === 1,
        authStatus,
        lastError: server?.lastError ?? null,
        sourceRef: source?.sourceRef ?? null,
        registryName: source?.registryName ?? null,
        registryVersion: source?.registryVersion ?? null,
        configJson: redactMcpConfigJson(server?.configJson ?? "{}"),
      };
    }));
    return { servers };
  }

  const registryCache = new LruMap<string, { at: number; page: Awaited<ReturnType<typeof fetchRegistryServers>> }>(64);
  async function registryPage(query: string, limit = 12, remoteOnly = false, cursor?: string) {
    const current = await settings.get();
    const baseUrl = current.registryUrl || OFFICIAL_REGISTRY;
    const key = JSON.stringify([baseUrl, query, limit, remoteOnly, cursor]);
    const cached = registryCache.get(key);
    const page = cached && Date.now() - cached.at < 60_000 ? cached.page : await fetchRegistryServers({
      baseUrl, search: query, limit: remoteOnly ? Math.min(limit * 2, 50) : limit, cursor,
    });
    if (page !== cached?.page) registryCache.set(key, { at: Date.now(), page });
    const hits = page.servers.map(registryHit);
    return { servers: remoteOnly ? hits.filter(hit => hit.remote) : hits, nextCursor: page.nextCursor };
  }
  async function searchRegistry(query: string, limit = 12, remoteOnly = false) {
    return (await registryPage(query, limit, remoteOnly)).servers;
  }

  async function addFromRegistry(name: string, extraHeaders?: Record<string, string>, displayName?: string) {
    const hits = await searchRegistry(name, 20);
    const exact = hits.find((hit) => hit.name === name) ?? hits.find((hit) => hit.name.toLowerCase() === name.toLowerCase());
    if (!exact) throw new Error(`Registry server not found: ${name}`);
    const current = await settings.get();
    const { servers } = await fetchRegistryServers({
      baseUrl: current.registryUrl || OFFICIAL_REGISTRY,
      search: exact.name,
      limit: 20,
    });
    const summary = servers.find((item) => item.name === exact.name);
    if (!summary) throw new Error(`Registry server not found: ${name}`);
    const install = normalizeRegistryServer(summary);
    if (!install) throw new Error(`No supported install package or remote for ${name}`);
    const config = extraHeaders && Object.keys(extraHeaders).length > 0
      ? { ...install.config, headers: { ...((install.config.headers as Record<string, string> | undefined) ?? {}), ...extraHeaders } }
      : install.config;
    return addServer({
      name: displayName ?? install.name,
      description: install.description,
      sourceKind: "registry",
      sourceRef: install.sourceRef,
      registryName: install.registryName,
      registryVersion: install.registryVersion,
      type: install.type,
      config,
    });
  }

  async function writeHeaders(id: string, headers?: Record<string, string>) {
    const { source, server } = await requireSource(id);
    if (server.type === "stdio") throw new Error("stdio MCP servers do not use HTTP headers");
    let cfg: Record<string, unknown>;
    try { cfg = JSON.parse(server.configJson) as Record<string, unknown>; }
    catch (error) { throw new Error(`invalid server config: ${errorText(error)}`); }
    if (headers && Object.keys(headers).length > 0) cfg.headers = headers;
    else delete cfg.headers;
    const validation = validateMcpServer(server.serverId, cfg);
    if (!validation.valid || !validation.config) throw new Error(validation.errors.join("; "));
    store.upsertMcpServer({ ...server, configJson: JSON.stringify(validation.config), lastError: null });
    await gateway.resetServer(source.id, server.serverId);
    await publishChanged({ kind: "headers", id: source.id });
  }

  async function approve(id: string) {
    const { source, server } = await requireSource(id);
    if (server.enabled !== 1) throw new Error(`Enable ${source.name} before approving it`);
    let cfg: Record<string, unknown>;
    try { cfg = JSON.parse(server.configJson) as Record<string, unknown>; }
    catch (error) { throw new Error(`Cannot approve invalid server: ${errorText(error)}`); }
    const validation = validateMcpServer(server.serverId, cfg);
    if (!validation.valid) throw new Error(`Cannot approve invalid server: ${validation.errors.join("; ")}`);
    store.upsertMcpServer({ ...server, approved: 1, status: "idle", lastError: null });
    await gateway.closeServer(source.id, server.serverId);
    try { await gateway.startServer(source.id, server.serverId); }
    catch (error) { bb.log.warn(`[mcps] first connect after approve ${server.serverId}: ${errorText(error)}`); }
    await publishChanged({ kind: "approve", id: source.id });
  }

  async function setEnabled(id: string, enabled: boolean) {
    const { source, server } = await requireSource(id);
    const next = store.setMcpEnabled(source.id, server.serverId, enabled);
    if (!next) throw new Error(`not found: ${id}`);
    if (!enabled) {
      store.upsertMcpServer({ ...next, status: "disabled", lastError: null });
      await gateway.closeServer(source.id, server.serverId);
    } else if (next.approved === 1) {
      store.upsertMcpServer({ ...next, status: "idle", lastError: null });
    }
    await publishChanged({ kind: "enable", id: source.id, enabled });
    return { enabled: next.enabled === 1, status: store.getServer(source.id, server.serverId)?.status ?? next.status };
  }

  async function invokeTool(opaqueId: string, args: JsonRecord, signal?: AbortSignal) {
    const tool = gateway.peekTool(opaqueId) ?? await gateway.getTool(opaqueId);
    const invalid = validateCallArgs(tool.inputSchema, args);
    if (invalid) {
      return { isError: true, error: `Invalid arguments for ${tool.name}: ${invalid}` };
    }
    return gateway.call(opaqueId, args, signal);
  }

  bb.http.route("GET", "/oauth/callback", async (context) => {
    const url = new URL(context.req.url);
    const pluginId = url.searchParams.get("pluginId");
    const serverId = url.searchParams.get("serverId");
    if (!pluginId || !serverId) return new Response("Missing MCPs OAuth callback context", { status: 400 });
    try {
      await withDeferredOAuthPersistence(() => gateway.finishAuth(pluginId, serverId, url.searchParams));
      await publishChanged({ kind: "oauth", id: pluginId, serverId });
      return new Response("<p>Authentication completed. You can close this window.</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      bb.log.warn(`[mcps] OAuth callback failed for ${serverId}: ${errorText(error)}`);
      return new Response("<p>Authentication failed. Return to BB and try again.</p>", { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  });

  bb.rpc.register(rpcContract, {
    snapshot: () => buildSnapshot(),
    async registrySearch({ query, limit, remoteOnly, cursor }) { return registryPage(query, limit ?? 12, remoteOnly === true, cursor); },
    addFromRegistry: ({ name, headers, headerLines }) => addFromRegistry(name, headersFromInput(headers, headerLines)),
    async addManual({ name, type, command, args, cwd, url, headers, headerLines }) {
      const config: Record<string, unknown> = { type };
      if (type === "stdio") {
        if (!command) throw new Error("stdio servers need a command");
        config.command = command;
        if (args) config.args = args;
        config.cwd = cwd || "${PLUGIN_DATA}";
      } else {
        if (!url) throw new Error("HTTP servers need a url");
        config.url = url;
        const httpHeaders = headersFromInput(headers, headerLines);
        if (httpHeaders) config.headers = httpHeaders;
      }
      return addServer({ name, sourceKind: "manual", sourceRef: type === "stdio" ? command : url, type, config });
    },
    async remove({ id }) {
      const source = store.resolveSource(id);
      if (!source) return { deleted: false };
      for (const server of store.listMcpServers(source.id)) {
        await gateway.resetServer(source.id, server.serverId).catch(() => {});
        await deleteOAuthCredentials(source.id, server.serverId).catch((error) => {
          bb.log.warn(`[mcps] ${errorText(error)}`);
        });
      }
      const deleted = store.deleteSource(source.id);
      await rimraf(path.dirname(source.pluginRoot)).catch(() => {});
      await publishChanged({ kind: "remove", id: source.id });
      return { deleted };
    },
    async approve({ id }) { await approve(id); return { approved: true }; },
    setEnabled: ({ id, enabled }) => setEnabled(id, enabled),
    async setHeaders({ id, headers, headerLines }) {
      await writeHeaders(id, headersFromInput(headers, headerLines));
      return { updated: true };
    },
    async authenticate({ id }) {
      const { source, server } = await requireSource(id);
      const url = await gateway.authUrl(source.id, server.serverId);
      return { url, status: await gateway.authStatus(source.id, server.serverId) };
    },
    async reconnect({ id }) {
      const { source, server } = await requireSource(id);
      const url = await gateway.reconnectServer(source.id, server.serverId);
      await publishChanged({ kind: "reconnect", id: source.id });
      return { url, status: await gateway.authStatus(source.id, server.serverId) };
    },
    async finishAuthentication({ id, callbackUrl }) {
      const { source, server } = await requireSource(id);
      await withDeferredOAuthPersistence(() => gateway.finishAuth(source.id, server.serverId, new URL(callbackUrl).searchParams));
      await publishChanged({ kind: "oauth", id: source.id });
      return { authenticated: true };
    },
    async cancelAuthentication({ id }) {
      const { source, server } = await requireSource(id);
      await withDeferredOAuthPersistence(() => gateway.cancelAuthentication(source.id, server.serverId));
      return { canceled: true };
    },
    async searchTools({ query, limit }) { return gateway.searchTools(query, limit ?? SEARCH_LIMIT); },
    async inspectServer({ id }) {
      const { source } = await requireSource(id);
      return gateway.inspectServer(source.id);
    },
  });

  // Old sessions can still send the previously advertised argument names.
  const idField = z.string().min(1).optional().describe("ID from discovery.");
  const idFields = { id: idField };
  function readId(input: Record<string, unknown>, legacy: string): string {
    const id = input.id ?? input[legacy] ?? input.opaqueId;
    if (typeof id !== "string" || !id.trim()) throw new Error("id is required");
    return id;
  }
  function hasId(input: Record<string, unknown>, legacy: string): boolean {
    try { readId(input, legacy); return true; } catch { return false; }
  }

  function toolRows(tools: Awaited<ReturnType<McpGateway["searchTools"]>>["tools"]) {
    return tools.map(tool => ({
      id: tool.opaqueId,
      server: tool.pluginId && store.getPlugin(tool.pluginId) ? store.identity(tool.pluginId).handle : tool.serverName,
      name: tool.name,
      description: tool.description,
      ...(tool.risk !== "read" ? { risk: tool.risk } : {}),
      ...(tool.card ? { input: Object.fromEntries(tool.card.fields.map(field => [field.name + (field.required ? "" : "?"), field.type])) } : { schemaRequired: true }),
      ...(tool.schemaRequired || tool.card?.truncated || tool.card?.shape.includes("…") || tool.card?.fields.length === 0 && tool.card.shape !== "{}" ? { schemaRequired: true } : {}),
    }));
  }

  async function serverRows(details = false) {
    const servers = await gateway.compactServers();
    return servers.map(item => ({
      ...store.identity(item.id),
      type: item.type,
      status: item.status,
      ...(item.toolCount !== null ? { tools: item.toolCount } : {}),
      ...(details ? {
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        sourceKind: item.sourceKind,
        ...(item.promptCount !== null ? { prompts: item.promptCount } : {}),
        ...(item.resourceCount !== null ? { resources: item.resourceCount } : {}),
        ...(store.getServer(item.id, item.serverId)?.lastError ? { error: store.getServer(item.id, item.serverId)!.lastError } : {}),
      } : {}),
    }));
  }

  const toolNames = ["mcps_servers", "mcps_search", "mcps_schema", "mcps_call", "mcps_prompts", "mcps_get_prompt", "mcps_resources", "mcps_read_resource"] as const;
  bb.agents.registerTool({
    name: "mcps_servers",
    description: "List installed MCPs with stable IDs, handles, status and known tool counts. Paginated; details opt-in.",
    instructions: "Use only to inspect installed servers, status, or handles. mcps_search does not require this first.",
    presentation: { label: { pending: "Listing MCP servers", completed: "Listed MCP servers" } },
    parameters: z.object({
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z.number().int().min(0).default(0),
      details: z.boolean().default(false),
    }).strict(),
    async execute({ query, limit, cursor, details }) {
      let rows = await serverRows(details);
      if (query) {
        const q = query.toLowerCase();
        rows = rows.filter(row => row.id === query || row.handle.toLowerCase().includes(q) || store.resolveSource(row.id)?.name.toLowerCase().includes(q));
      }
      rows.sort((a, b) => a.handle.localeCompare(b.handle));
      const servers = rows.slice(cursor, cursor + limit);
      return agentData({ servers, ...(cursor + limit < rows.length ? { nextCursor: cursor + limit } : {}) }, "servers");
    },
  });
  bb.agents.registerTool({
    name: "mcps_search",
    description: "Search MCP tools directly; returns id, server handle, description and input fields (? optional, dots nested). Default 5 results; optional limit is capped at 12.",
    instructions: "Do not list servers first. Search a short capability phrase, optionally filtering by a known server ID or handle. Usually omit limit; oversized values are capped. Call by id. Request mcps_schema only for missing constraints or schemaRequired results.",
    presentation: { label: { pending: "Searching MCP tools", completed: "Searched MCP tools" } },
    parameters: z.object({
      query: z.string().trim().min(1).max(200),
      server: z.string().max(128).optional(),
      limit: z.number().int().min(1).optional().describe("Desired result count; values above 12 are capped. Usually omit."),
    }).strict(),
    async execute({ query, limit, server }) {
      const result = await gateway.searchTools(query, Math.min(limit ?? SEARCH_LIMIT, SEARCH_MAX), server);
      return agentData({ tools: toolRows(result.tools), ...(result.unavailable.length ? { unavailable: result.unavailable } : {}) }, "search");
    },
  });
  bb.agents.registerTool({
    name: "mcps_schema",
    description: "Get one tool's full description and input schema by id. Large schemas are saved as artifacts.",
    instructions: "Use when search input is insufficient. Read artifactPath for schemas too large to inline.",
    presentation: { label: { pending: "Loading MCP schema", completed: "Loaded MCP schema" } },
    parameters: z.object(idFields).passthrough().refine(v => hasId(v, "toolId"), "id is required"),
    async execute(input) {
      const tool = await gateway.getTool(readId(input, "toolId"));
      const schemaJson = JSON.stringify(tool.inputSchema);
      const payload: JsonRecord = {
        id: tool.opaqueId,
        name: tool.name,
        description: tool.description,
        risk: classifyTool(tool.annotations),
      };
      if (schemaJson.length <= SCHEMA_INLINE_CHARS) payload.inputSchema = tool.inputSchema;
      else {
        payload.bytes = Buffer.byteLength(schemaJson, "utf8");
        payload.artifactPath = await writeArtifact(JSON.stringify(tool.inputSchema, null, 2), {
          artifactDir: await artifactDir(),
          name: "schema",
        });
      }
      return agentData(payload, "schema");
    },
  });
  bb.agents.registerTool({
    name: "mcps_call",
    description: "Call one MCP tool by tool ID. Does not re-list the catalog.",
    instructions: "Use id from mcps_search. Report the result to the user; the UI may show only a success envelope.",
    presentation: { label: { pending: "Calling MCP tool", completed: "Called MCP tool" } },
    parameters: z.object({
      ...idFields,
      args: jsonRecordSchema.default({}),
    }).passthrough().refine(v => hasId(v, "toolId"), "id is required"),
    async execute(input, ctx) {
      return agentReply(await invokeTool(readId(input, "toolId"), input.args as JsonRecord, ctx.signal), "call");
    },
  });
  bb.agents.registerTool({
    name: "mcps_prompts",
    description: "Search compact MCP prompts. Pass query; default 5 hits.",
    presentation: { label: { pending: "Searching MCP prompts", completed: "Searched MCP prompts" } },
    parameters: z.object({ query: z.string().trim().max(200).optional(), server: z.string().max(128).optional() }).strict(),
    async execute({ query, server }) {
      const prompts = await gateway.listPrompts(server);
      const q = query?.trim() ?? "";
      const rows = prompts.map((item) => ({
        id: item.opaqueId,
        server: store.getPlugin(item.pluginId) ? store.identity(item.pluginId).handle : item.pluginName,
        name: item.name,
        description: item.description ?? "",
        score: q ? scoreMatch(q, [item.name, item.description ?? "", item.pluginName, item.pluginId]) : 1,
      })).filter((item) => item.score > 0);
      rows.sort((a, b) => b.score - a.score);
      return agentData({ prompts: rows.slice(0, SEARCH_LIMIT).map(({ score: _, ...item }) => item) }, "prompts");
    },
  });
  bb.agents.registerTool({
    name: "mcps_get_prompt",
    description: "Get one MCP prompt by prompt ID.",
    instructions: "Use id from mcps_prompts.",
    presentation: { label: { pending: "Getting MCP prompt", completed: "Got MCP prompt" } },
    parameters: z.object({ ...idFields, args: jsonRecordSchema.default({}) }).passthrough().refine(v => hasId(v, "promptId"), "id is required"),
    async execute(input, ctx) {
      return agentReply(await gateway.getPrompt(readId(input, "promptId"), input.args as JsonRecord, ctx.signal), "prompt");
    },
  });
  bb.agents.registerTool({
    name: "mcps_resources",
    description: "Search compact MCP resources. Pass query; default 5 hits.",
    presentation: { label: { pending: "Searching MCP resources", completed: "Searched MCP resources" } },
    parameters: z.object({ query: z.string().trim().max(200).optional(), server: z.string().max(128).optional() }).strict(),
    async execute({ query, server }) {
      const [resources, resourceTemplates] = await Promise.all([gateway.listResources(server), gateway.listResourceTemplates(server)]);
      const q = query?.trim() ?? "";
      const rows = [
        ...resources.map((item) => ({ id: item.opaqueId, server: store.getPlugin(item.pluginId) ? store.identity(item.pluginId).handle : item.pluginName, uri: item.uri, name: item.name, score: q ? scoreMatch(q, [item.name, item.uri, item.pluginName, item.pluginId]) : 1 })),
        ...resourceTemplates.map((item) => ({ id: item.opaqueId, server: store.getPlugin(item.pluginId) ? store.identity(item.pluginId).handle : item.pluginName, uri: item.uriTemplate, name: item.name, score: q ? scoreMatch(q, [item.name, item.uriTemplate, item.pluginName, item.pluginId]) : 1 })),
      ].filter((item) => item.score > 0);
      rows.sort((a, b) => b.score - a.score);
      return agentData({ resources: rows.slice(0, SEARCH_LIMIT).map(({ score: _, ...item }) => item) }, "resources");
    },
  });
  bb.agents.registerTool({
    name: "mcps_read_resource",
    description: "Read one MCP resource by resource ID.",
    instructions: "Use id from mcps_resources.",
    presentation: { label: { pending: "Reading MCP resource", completed: "Read MCP resource" } },
    parameters: z.object(idFields).passthrough().refine(v => hasId(v, "resourceId"), "id is required"),
    async execute(input, ctx) { return agentReply(await gateway.readResource(readId(input, "resourceId"), ctx.signal), "resource"); },
  });
  bb.agents.configure(() => ({
    tools: [...toolNames],
    skills: ["mcps"],
  }));

  function looksLikeUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
  }
  function nameFromSource(value: string): string {
    if (looksLikeUrl(value)) {
      try { return slug(new URL(value).hostname.replace(/^(mcp|www)\./, "")) || "http"; }
      catch { return "http"; }
    }
    return slug(value);
  }
  async function addFromArgv(opts: { positional: string[]; headerLines: string[]; sse: boolean; stdio: boolean; name?: string }) {
    const dash = opts.positional.indexOf("--");
    const before = dash >= 0 ? opts.positional.slice(0, dash) : opts.positional;
    const after = dash >= 0 ? opts.positional.slice(dash + 1) : [];
    const headers = headersFromInput(undefined, opts.headerLines);
    if (opts.stdio || after.length > 0) {
      const name = opts.name || before[0];
      const commandArgs = after.length > 0 ? after : before.slice(opts.name ? 0 : 1);
      const commandName = commandArgs[0];
      if (!name || !commandName) throw new Error("Usage: bb mcps add <name> -- <command> [args...]");
      return addServer({
        name,
        sourceKind: "manual",
        sourceRef: commandName,
        type: "stdio",
        config: { type: "stdio", command: commandName, args: commandArgs.slice(1), cwd: "${PLUGIN_DATA}" },
      });
    }
    const source = before.length >= 2 ? before[1]! : before[0];
    if (!source) throw new Error("Usage: bb mcps add <name> <url|registry-id>");
    const explicitName = opts.name || (before.length >= 2 ? before[0]! : undefined);
    if (looksLikeUrl(source) || opts.sse) {
      const name = explicitName || nameFromSource(source);
      const type = opts.sse || source.includes("/sse") ? "sse" as const : "streamable-http" as const;
      return addServer({
        name,
        sourceKind: "manual",
        sourceRef: source,
        type,
        config: headers ? { type, url: source, headers } : { type, url: source },
      });
    }
    return addFromRegistry(source, headers, explicitName);
  }

  const usage = [
    "Usage:",
    "  bb mcps list [--details] [--json]",
    "  bb mcps show <id> [--json]",
    "  bb mcps add <name> <url> [--header 'Name: value'] [--sse] [--json]",
    "  bb mcps add <name> <registry-id> [--header 'Name: value'] [--json]",
    "  bb mcps add <name> -- <command> [args...] [--json]",
    "  bb mcps registry <query> [--http] [--json]",
    "  bb mcps tools <query> [--json]",
    "  bb mcps auth <id> [--json]",
    "  bb mcps header <id> Name: value [--json]",
    "  bb mcps enable <id> [--json]",
    "  bb mcps disable <id> [--json]",
    "  bb mcps remove <id> [--json]",
    "  bb mcps call <id> [json-args] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "mcps",
    summary: "Manage MCP servers for every provider",
    commands: [
      { name: "list", summary: "List installed MCP servers", usage: "bb mcps list [--details] [--json]" },
      { name: "show", summary: "Show one MCP server", usage: "bb mcps show <id> [--json]" },
      { name: "add", summary: "Add an HTTP URL, registry id, or local command", usage: "bb mcps add <name> <url|registry-id>  |  bb mcps add <name> -- <command> [args...]" },
      { name: "registry", summary: "Search the official MCP Registry", usage: "bb mcps registry <query> [--http] [--json]" },
      { name: "tools", summary: "Search tools on enabled servers", usage: "bb mcps tools <query> [--json]" },
      { name: "auth", summary: "Start or inspect OAuth for an HTTP server", usage: "bb mcps auth <id> [--json]" },
      { name: "header", summary: "Set HTTP headers on a cloud server", usage: "bb mcps header <id> Name: value [--json]" },
      { name: "enable", summary: "Enable a server", usage: "bb mcps enable <id> [--json]" },
      { name: "disable", summary: "Disable a server", usage: "bb mcps disable <id> [--json]" },
      { name: "remove", summary: "Remove a server", usage: "bb mcps remove <id> [--json]" },
      { name: "call", summary: "Call one MCP tool by tool ID", usage: "bb mcps call <id> [json-args] [--json]" },
    ],
    async run(argv) {
      const asJson = argv.includes("--json");
      const args = argv.filter((item) => item !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: (asJson ? JSON.stringify(value) : text) + "\n" });
      const takeOptions = (argv: string[]) => {
        const positional: string[] = [];
        const headerLines: string[] = [];
        let sse = false;
        let remoteOnly = false;
        let stdio = false;
        let name: string | undefined;
        for (let i = 0; i < argv.length; i += 1) {
          const item = argv[i]!;
          if (item === "--sse") sse = true;
          else if (item === "--remote" || item === "--http") remoteOnly = true;
          else if (item === "--stdio") stdio = true;
          else if (item === "--name") {
            const value = argv[i + 1];
            if (!value) throw new Error("--name needs a value");
            name = value;
            i += 1;
          } else if (item.startsWith("--name=")) name = item.slice("--name=".length);
          else if (item === "--header") {
            const value = argv[i + 1];
            if (!value) throw new Error("--header needs a 'Name: value' argument");
            headerLines.push(value);
            i += 1;
          } else if (item.startsWith("--header=")) headerLines.push(item.slice("--header=".length));
          else positional.push(item);
        }
        return { positional, headerLines, sse, remoteOnly, stdio, name };
      };
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage + "\n" };
          case "list":
          case "ls": {
            const rows = await serverRows(rest.includes("--details"));
            return reply(rows, rows.length === 0
              ? "No MCP servers. Try: bb mcps registry notion"
              : rows.map((item) => `${item.id}  ${item.handle}  ${item.type}  ${item.status}`).join("\n"));
          }
          case "show": {
            if (!rest[0]) break;
            const snap = await buildSnapshot();
            const item = snap.servers.find((row) => row.id === rest[0] || row.handle === rest[0] || row.name === rest[0]);
            if (!item) return { exitCode: 1, stderr: `not found: ${rest[0]}\n` };
            return reply(item, [
              `id: ${item.id}`,
              `handle: ${item.handle}`,
              `name: ${item.name}`,
              `type: ${item.type}`,
              `status: ${item.status}`,
              `enabled: ${item.enabled}`,
              `auth: ${item.authStatus}`,
              item.sourceRef ? `source: ${item.sourceRef}` : null,
              item.registryName ? `registry: ${item.registryName}` : null,
              item.lastError ? `error: ${item.lastError}` : null,
            ].filter(Boolean).join("\n"));
          }
          case "registry":
          case "search":
          case "find": {
            const opts = takeOptions(rest);
            const query = opts.positional.join(" ").trim();
            if (!query) break;
            const servers = await searchRegistry(query, 12, opts.remoteOnly);
            return reply(servers, servers.length === 0 ? "No registry matches." : servers.map((item) => `${item.remote ? "http" : item.type ?? "unsupported"}  ${item.name}  ${item.requiredHeaders.length ? `headers:${item.requiredHeaders.join(",")}` : ""}  ${item.description}`.replace(/\s+/g, " ").trim()).join("\n"));
          }
          case "add":
          case "install":
          case "add-http":
          case "add-stdio":
          case "add-registry": {
            const opts = takeOptions(rest);
            if (command === "add-stdio") opts.stdio = true;
            if (command === "add-http") opts.sse = opts.sse || Boolean(opts.positional[1]?.includes("/sse"));
            const added = await addFromArgv(opts);
            return reply(added, `Added ${added.name} (${added.id})`);
          }
          case "header":
          case "headers": {
            const opts = takeOptions(rest);
            const id = opts.positional[0];
            if (!id) break;
            const inline = opts.positional.slice(1).join(" ").trim();
            const lines = [...opts.headerLines];
            if (inline) lines.push(inline);
            await writeHeaders(id, headersFromInput(undefined, lines));
            return reply({ updated: true, id }, `Updated headers for ${id}`);
          }
          case "approve": {
            if (!rest[0]) break;
            await approve(rest[0]);
            return reply({ approved: true, id: rest[0] }, `Approved ${rest[0]}`);
          }
          case "enable":
          case "disable": {
            if (!rest[0]) break;
            const result = await setEnabled(rest[0], command === "enable");
            return reply(result, `${command}d ${rest[0]}`);
          }
          case "remove":
          case "delete":
          case "rm": {
            if (!rest[0]) break;
            const source = store.resolveSource(rest[0]);
            if (!source) return { exitCode: 1, stderr: `not found: ${rest[0]}\n` };
            for (const server of store.listMcpServers(source.id)) {
              await gateway.resetServer(source.id, server.serverId).catch(() => {});
              await deleteOAuthCredentials(source.id, server.serverId).catch(() => {});
            }
            store.deleteSource(source.id);
            await rimraf(path.dirname(source.pluginRoot)).catch(() => {});
            await publishChanged({ kind: "remove", id: source.id });
            return reply({ deleted: true, id: rest[0] }, `Removed ${source.name}`);
          }
          case "auth": {
            if (!rest[0]) break;
            const { source, server } = await requireSource(rest[0]);
            const url = await gateway.authUrl(source.id, server.serverId);
            const status = await gateway.authStatus(source.id, server.serverId);
            return reply({ url, status }, url ? `${status}\n${url}` : status);
          }
          case "tools": {
            const query = rest.join(" ").trim();
            if (!query) break;
            const { tools, unavailable } = await gateway.searchTools(query);
            const lines = tools.map((tool) => `${tool.opaqueId}  ${tool.name}  ${tool.description}`);
            if (unavailable.length > 0) lines.push(`unavailable: ${unavailable.join("; ")}`);
            return reply({ tools: toolRows(tools), ...(unavailable.length ? { unavailable } : {}) }, lines.length === 0 ? "No matching tools." : lines.join("\n"));
          }
          case "call": {
            const opaqueId = rest[0];
            if (!opaqueId) break;
            let callArgs: JsonRecord = {};
            if (rest[1]) {
              try { callArgs = JSON.parse(rest.slice(1).join(" ")) as JsonRecord; }
              catch { return { exitCode: 2, stderr: "call args must be JSON object\n" }; }
            }
            const result = await invokeTool(opaqueId, callArgs);
            return reply(result, JSON.stringify(result, null, 2));
          }
        }
      } catch (error) {
        return { exitCode: 1, stderr: errorText(error) + "\n" };
      }
      return { exitCode: 2, stderr: usage + "\n" };
    },
  });

  bb.onDispose(async () => {
    await gateway.close().catch(() => {});
    oauthCredentialStore.dispose();
    bb.log.info("[mcps] disposed");
  });
}
