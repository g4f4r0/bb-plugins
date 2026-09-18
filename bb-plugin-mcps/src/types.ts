export type JsonRecord = Record<string, unknown>;

export type McpServerType = "stdio" | "streamable-http" | "sse";
export type McpSourceKind = "manual" | "registry";
export type ToolRisk = "read" | "write" | "destructive";

export interface McpSourceRecord {
  id: string;
  name: string;
  description: string | null;
  sourceKind: McpSourceKind;
  sourceRef: string | null;
  registryName: string | null;
  registryVersion: string | null;
  pluginRoot: string;
  pluginData: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerRecord {
  pluginId: string;
  serverId: string;
  type: McpServerType;
  configJson: string;
  status: "idle" | "ready" | "error" | "disabled" | "needs-approval" | "needs-auth";
  lastError: string | null;
  approved: number;
  enabled: number;
}

export interface CatalogTool {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  name: string;
  description: string;
  inputSchema: JsonRecord;
  outputSchema?: JsonRecord;
  annotations?: JsonRecord;
  execution?: JsonRecord;
  icons?: JsonRecord[];
  _meta?: JsonRecord;
  status: "ready" | "error";
  error?: string;
}

export interface CatalogPrompt {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  name: string;
  title?: string;
  description?: string;
  arguments?: JsonRecord[];
  icons?: JsonRecord[];
  _meta?: JsonRecord;
  status: "ready" | "error";
  error?: string;
}

export interface CatalogResource {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: JsonRecord[];
  _meta?: JsonRecord;
  status: "ready" | "error";
  error?: string;
}

export interface CatalogResourceTemplate {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: JsonRecord[];
  _meta?: JsonRecord;
  status: "ready" | "error";
  error?: string;
}

export interface McpCallResult {
  content: JsonRecord[];
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: JsonRecord;
}

export interface CompactServer {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  sourceKind: McpSourceKind;
  toolCount: number | null;
  promptCount: number | null;
  resourceCount: number | null;
}

export interface CompactTool {
  schemaRequired?: boolean;
  pluginId?: string;
  opaqueId: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  risk: ToolRisk;
  enabled: boolean;
  card?: {
    truncated?: boolean;
    shape: string;
    fields: Array<{ name: string; type: string; required: boolean; enum?: string[] }>;
    example: JsonRecord;
  };
}

export interface ToolSearchHits {
  tools: CompactTool[];
  unavailable: string[];
}

export interface BoundedOutput {
  json: string;
  truncated: boolean;
  bytes: number;
  artifactPath?: string;
}
