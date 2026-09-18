import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { BoundedOutput, CompactTool, JsonRecord, ToolSearchHits } from "./types.js";
import { callCard } from "./call-card.js";
import { classifyTool } from "./policy.js";

export const SEARCH_LIMIT = 5;
export const INDEX_LIMIT = 64;
export const DESCRIPTION_CHARS = 180;
export const AGENT_OUTPUT_CHARS = 12_000;
export const SCHEMA_INLINE_CHARS = 2_000;

export function clip(text: string, max = DESCRIPTION_CHARS): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token.length >= 2);
}

export function scoreMatch(query: string, fields: string[]): number {
  return scoreTokens(tokenize(query), fields[0]?.toLowerCase() ?? "", fields.join("\n").toLowerCase());
}

/** Score already normalized search data without retokenizing every tool. */
export function scoreTokens(tokens: string[], name: string, haystack: string): number {
  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) return 0;
    score += name === token ? 8 : name.includes(token) ? 5 : 1;
  }
  return score;
}

export function compactToolFromCatalog(tool: {
  opaqueId: string;
  serverId: string;
  pluginName: string;
  pluginId?: string;
  name: string;
  description: string;
  annotations?: JsonRecord;
  enabled?: boolean;
  inputSchema?: JsonRecord;
}, options?: { card?: boolean }): CompactTool {
  const schema = tool.inputSchema ?? { type: "object" };
  const card = options?.card ? callCard(schema) : undefined;
  const schemaRequired = /"(?:oneOf|anyOf|allOf|\$ref|if|dependentRequired)"\s*:/.test(JSON.stringify(schema));
  return {
    opaqueId: tool.opaqueId,
    ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
    serverId: tool.serverId,
    serverName: tool.pluginName,
    name: tool.name,
    description: clip(tool.description),
    risk: classifyTool(tool.annotations),
    enabled: tool.enabled !== false,
    ...(card ? { card, ...(schemaRequired ? { schemaRequired: true } : {}) } : {}),
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function compactIfJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

function formatContentBlock(block: Record<string, unknown>): string {
  if (block.type === "text" && typeof block.text === "string") return compactIfJson(block.text);
  if (block.type === "image" || block.type === "audio" || block.type === "blob") {
    const mime = typeof block.mimeType === "string" ? ` ${block.mimeType}` : "";
    return `[${block.type}${mime} omitted]`;
  }
  if (typeof block.data === "string" && block.data.length > 256) {
    return `[${typeof block.type === "string" ? block.type : "data"} omitted ${block.data.length} bytes]`;
  }
  return JSON.stringify(block);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function formatMcpResult(value: unknown): { text: string; isError: boolean } {
  if (value == null) return { text: "null", isError: false };
  if (typeof value === "string") return { text: compactIfJson(value), isError: false };
  if (typeof value !== "object") return { text: String(value), isError: false };
  const record = value as Record<string, unknown>;
  const isError = record.isError === true;
  if (isError && typeof record.error === "string" && !Array.isArray(record.content)) {
    return { text: record.error, isError: true };
  }
  const chunks: string[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (!part || typeof part !== "object") {
        chunks.push(String(part));
        continue;
      }
      chunks.push(formatContentBlock(part as Record<string, unknown>));
    }
  }
  if (record.structuredContent !== undefined) {
    const duplicate = chunks.some((chunk) => {
      try {
        return sameJson(JSON.parse(chunk), record.structuredContent);
      } catch {
        return false;
      }
    });
    if (!duplicate) chunks.push(JSON.stringify(record.structuredContent));
  }
  if (chunks.length > 0) return { text: chunks.join("\n\n"), isError };
  const pretty = JSON.stringify(value);
  if (pretty.length <= AGENT_OUTPUT_CHARS) return { text: pretty, isError };
  return { text: JSON.stringify(value), isError };
}

export function packSearchResult(result: ToolSearchHits, maxChars = AGENT_OUTPUT_CHARS): ToolSearchHits {
  const unavailable = [...result.unavailable];
  const tools = result.tools.map((tool) => ({
    ...tool,
    ...(tool.card ? { card: { ...tool.card, fields: [...tool.card.fields], example: { ...tool.card.example } } } : {}),
  }));
  const pack = () => JSON.stringify({ tools, unavailable });
  while (pack().length > maxChars && tools.length > 0) {
    const last = tools[tools.length - 1]!;
    if (last.card?.fields.length) last.card = { ...last.card, fields: [] };
    else if (last.card) delete last.card;
    else tools.pop();
  }
  return { tools, unavailable };
}

export async function boundText(text: string, options: {
  maxChars?: number;
  artifactDir?: string;
  name?: string;
} = {}): Promise<string> {
  const maxChars = options.maxChars ?? AGENT_OUTPUT_CHARS;
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.length <= maxChars) return text;
  let artifactPath: string | undefined;
  if (options.artifactDir) {
    await fsp.mkdir(options.artifactDir, { recursive: true });
    const digest = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
    artifactPath = path.join(options.artifactDir, `${options.name ?? "result"}-${digest}.txt`);
    await fsp.writeFile(artifactPath, text, "utf8");
  }
  const preview = text.slice(0, Math.max(0, maxChars - 200));
  return `${preview}\n\n… truncated ${bytes} bytes${artifactPath ? ` at ${artifactPath}` : ""}`;
}

export async function writeArtifact(contents: string, options: { artifactDir: string; name: string; ext?: string }): Promise<string> {
  await fsp.mkdir(options.artifactDir, { recursive: true });
  const digest = crypto.createHash("sha256").update(contents).digest("hex").slice(0, 12);
  const artifactPath = path.join(options.artifactDir, `${options.name}-${digest}.${options.ext ?? "json"}`);
  await fsp.writeFile(artifactPath, contents, "utf8");
  return artifactPath;
}

export async function boundJson(value: unknown, options: {
  maxChars?: number;
  artifactDir?: string;
  name?: string;
} = {}): Promise<BoundedOutput> {
  const maxChars = options.maxChars ?? AGENT_OUTPUT_CHARS;
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (json.length <= maxChars) return { json, truncated: false, bytes };
  let artifactPath: string | undefined;
  if (options.artifactDir) {
    await fsp.mkdir(options.artifactDir, { recursive: true });
    const digest = crypto.createHash("sha256").update(json).digest("hex").slice(0, 12);
    artifactPath = path.join(options.artifactDir, `${options.name ?? "result"}-${digest}.json`);
    await fsp.writeFile(artifactPath, json, "utf8");
  }
  const preview = json.slice(0, Math.max(0, maxChars - 200));
  return {
    json: JSON.stringify({
      truncated: true,
      bytes,
      artifactPath: artifactPath ?? null,
      preview,
    }),
    truncated: true,
    bytes,
    artifactPath,
  };
}
