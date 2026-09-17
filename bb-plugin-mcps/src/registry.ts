import type { McpServerType } from "./loader.js";

export const OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io";

export interface RegistryHeader {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
}

export interface RegistryServerSummary {
  name: string;
  description: string;
  version: string;
  status: string;
  remotes: Array<{ type: string; url: string; headers: RegistryHeader[] }>;
  packages: Array<{ registryType: string; identifier: string; version?: string; runtimeHint?: string }>;
}

export interface NormalizedInstall {
  name: string;
  description: string;
  sourceRef: string;
  registryName: string;
  registryVersion: string;
  type: McpServerType;
  config: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function officialMeta(entry: Record<string, unknown>): Record<string, unknown> | null {
  const meta = asRecord(entry._meta);
  return meta ? asRecord(meta["io.modelcontextprotocol.registry/official"]) : null;
}

export function parseRegistryList(payload: unknown): RegistryServerSummary[] {
  const root = asRecord(payload);
  const servers = Array.isArray(root?.servers) ? root.servers : [];
  const out: RegistryServerSummary[] = [];
  for (const item of servers) {
    const wrapper = asRecord(item);
    const server = asRecord(wrapper?.server) ?? wrapper;
    if (!server) continue;
    const name = asString(server.name);
    const description = asString(server.description) ?? "";
    const version = asString(server.version) ?? "";
    if (!name) continue;
    const status = asString(officialMeta(wrapper ?? server)?.status) ?? "active";
    const remotes = Array.isArray(server.remotes) ? server.remotes.flatMap((remote) => {
      const rec = asRecord(remote);
      const type = asString(rec?.type);
      const url = asString(rec?.url);
      if (!type || !url) return [];
      const headers = Array.isArray(rec?.headers) ? rec.headers.flatMap((header) => {
        const item = asRecord(header);
        const name = asString(item?.name);
        if (!name) return [];
        return [{
          name,
          description: asString(item?.description),
          isRequired: item?.isRequired === true,
          isSecret: item?.isSecret === true,
          default: asString(item?.default),
        }];
      }) : [];
      return [{ type, url, headers }];
    }) : [];
    const packages = Array.isArray(server.packages) ? server.packages.flatMap((pkg) => {
      const rec = asRecord(pkg);
      const registryType = asString(rec?.registryType);
      const identifier = asString(rec?.identifier);
      if (!registryType || !identifier) return [];
      return [{
        registryType,
        identifier,
        version: asString(rec?.version),
        runtimeHint: asString(rec?.runtimeHint),
      }];
    }) : [];
    out.push({ name, description, version, status, remotes, packages });
  }
  return out;
}

export function normalizeRegistryServer(summary: RegistryServerSummary): NormalizedInstall | null {
  const remote = summary.remotes.find((item) => item.type === "streamable-http" || item.type === "sse" || item.url.startsWith("http"));
  if (remote) {
    const type: McpServerType = remote.type === "sse" ? "sse" : "streamable-http";
    const headers: Record<string, string> = {};
    for (const header of remote.headers) {
      if (header.default && !header.isSecret) headers[header.name] = header.default;
    }
    return {
      name: summary.name,
      description: summary.description,
      sourceRef: remote.url,
      registryName: summary.name,
      registryVersion: summary.version,
      type,
      config: Object.keys(headers).length > 0 ? { type, url: remote.url, headers } : { type, url: remote.url },
    };
  }
  const npm = summary.packages.find((item) => item.registryType === "npm");
  if (npm) {
    const spec = npm.version ? `${npm.identifier}@${npm.version}` : npm.identifier;
    const command = npm.runtimeHint && /^[a-zA-Z0-9._-]+$/.test(npm.runtimeHint) ? npm.runtimeHint : "npx";
    const args = command === "npx" ? ["-y", spec] : [spec];
    return {
      name: summary.name,
      description: summary.description,
      sourceRef: `npm:${spec}`,
      registryName: summary.name,
      registryVersion: summary.version,
      type: "stdio",
      config: { type: "stdio", command, args, cwd: "${PLUGIN_DATA}" },
    };
  }
  const pypi = summary.packages.find((item) => item.registryType === "pypi");
  if (pypi) {
    const spec = pypi.version ? `${pypi.identifier}==${pypi.version}` : pypi.identifier;
    return {
      name: summary.name,
      description: summary.description,
      sourceRef: `pypi:${spec}`,
      registryName: summary.name,
      registryVersion: summary.version,
      type: "stdio",
      config: { type: "stdio", command: "uvx", args: [spec], cwd: "${PLUGIN_DATA}" },
    };
  }
  return null;
}

export async function fetchRegistryServers(options: {
  baseUrl?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<{ servers: RegistryServerSummary[]; nextCursor: string | null }> {
  const base = (options.baseUrl ?? OFFICIAL_REGISTRY).replace(/\/+$/, "");
  const url = new URL(`${base}/v0.1/servers`);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(Math.min(options.limit ?? 12, 50)));
  if (options.search) url.searchParams.set("search", options.search);
  if (options.cursor) url.searchParams.set("cursor", options.cursor);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 8000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`MCP registry HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  const servers = parseRegistryList(payload);
  const metadata = asRecord(asRecord(payload)?.metadata);
  const nextCursor = asString(metadata?.nextCursor) ?? null;
  return { servers, nextCursor };
}
