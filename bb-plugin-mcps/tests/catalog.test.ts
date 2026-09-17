import { describe, expect, it } from "vitest";
import { clip, compactToolFromCatalog, formatMcpResult, packSearchResult, scoreMatch } from "../src/catalog.js";
import { classifyTool } from "../src/policy.js";
import { normalizeRegistryServer, parseRegistryList } from "../src/registry.js";

describe("catalog search", () => {
  it("requires every token and promotes an exact name", () => {
    expect(scoreMatch("create page", ["create_page", "notion", "Create a Notion page"])).toBeGreaterThan(
      scoreMatch("create page", ["search", "notion", "Search Notion"]),
    );
    expect(scoreMatch("notion", ["create_page", "files", "write a file"])).toBe(0);
  });

  it("clips descriptions and keeps compact tools schema-free", () => {
    const compact = compactToolFromCatalog({
      opaqueId: "src__mcp__echo_abc",
      serverId: "mcp",
      pluginName: "Echo",
      name: "echo",
      description: "x".repeat(400),
      annotations: { readOnlyHint: true },
    });
    expect(compact.description.endsWith("…")).toBe(true);
    expect(compact.risk).toBe("read");
    expect(clip("short")).toBe("short");
  });
});

describe("tool risk", () => {
  it("classifies tools from annotations", () => {
    expect(classifyTool({ destructiveHint: true })).toBe("destructive");
    expect(classifyTool({ readOnlyHint: true })).toBe("read");
    expect(classifyTool(undefined)).toBe("write");
  });
});

describe("official MCP registry", () => {
  it("prefers streamable HTTP remotes, then npm, then pypi", () => {
    const [http, npm, pypi, empty] = parseRegistryList({
      servers: [
        { server: { name: "io.example/http", description: "remote", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.example/mcp" }] } },
        { server: { name: "io.example/npm", description: "pkg", version: "2.0.0", packages: [{ registryType: "npm", identifier: "@example/mcp", version: "2.0.0" }] } },
        { server: { name: "io.example/py", description: "py", version: "3.0.0", packages: [{ registryType: "pypi", identifier: "example-mcp" }] } },
        { server: { name: "io.example/empty", description: "", version: "0" } },
      ],
    });
    expect(normalizeRegistryServer(http!)?.config).toEqual({ type: "streamable-http", url: "https://mcp.example/mcp" });
    expect(normalizeRegistryServer(npm!)?.config).toEqual({
      type: "stdio", command: "npx", args: ["-y", "@example/mcp@2.0.0"], cwd: "${PLUGIN_DATA}",
    });
    expect(normalizeRegistryServer(pypi!)?.config).toEqual({
      type: "stdio", command: "uvx", args: ["example-mcp"], cwd: "${PLUGIN_DATA}",
    });
    expect(normalizeRegistryServer(empty!)).toBeNull();
  });

  it("keeps non-secret remote header defaults and lists required secrets", () => {
    const [remote] = parseRegistryList({
      servers: [{
        server: {
          name: "io.example/cloud",
          description: "hosted",
          version: "1",
          remotes: [{
            type: "streamable-http",
            url: "https://mcp.example/mcp",
            headers: [
              { name: "X-Region", default: "us-east-1", isSecret: false },
              { name: "Authorization", isRequired: true, isSecret: true },
            ],
          }],
        },
      }],
    });
    expect(remote?.remotes[0]?.headers).toEqual([
      expect.objectContaining({ name: "X-Region", default: "us-east-1" }),
      expect.objectContaining({ name: "Authorization", isRequired: true, isSecret: true }),
    ]);
    expect(normalizeRegistryServer(remote!)?.config).toEqual({
      type: "streamable-http",
      url: "https://mcp.example/mcp",
      headers: { "X-Region": "us-east-1" },
    });
  });
});

describe("formatMcpResult", () => {
  it("unwraps MCP text content and pretty-prints nested JSON", () => {
    const formatted = formatMcpResult({
      content: [{ type: "text", text: "{\"results\":[{\"title\":\"Tasks\"}]}" }],
      isError: false,
    });
    expect(formatted.isError).toBe(false);
    expect(formatted.text).toContain('"title": "Tasks"');
    expect(formatted.text).not.toContain('"content"');
  });

  it("uses the policy error string", () => {
    expect(formatMcpResult({ isError: true, error: "MCP tool is disabled" })).toEqual({
      text: "MCP tool is disabled",
      isError: true,
    });
  });

  it("skips structuredContent that duplicates text and omits binary blocks", () => {
    const payload = { results: [{ title: "Tasks" }] };
    const formatted = formatMcpResult({
      content: [
        { type: "text", text: JSON.stringify(payload) },
        { type: "image", mimeType: "image/png", data: "a".repeat(400) },
      ],
      structuredContent: payload,
    });
    expect(formatted.text).toContain('"title": "Tasks"');
    expect(formatted.text).toContain("[image image/png omitted]");
    expect(formatted.text.split("Tasks").length).toBe(2);
  });
});

describe("packSearchResult", () => {
  it("drops trailing cards instead of slicing JSON", () => {
    const tools = Array.from({ length: 8 }, (_, index) => ({
      opaqueId: `id${index}`,
      serverId: "mcp",
      serverName: "S",
      name: `tool_${index}`,
      description: "d",
      risk: "read" as const,
      enabled: true,
      card: { shape: "{ " + "x".repeat(4000) + " }", fields: [{ name: "a", type: "string", required: true }], example: { a: "" } },
    }));
    const packed = packSearchResult({ tools, unavailable: ["Slow"] }, 2_000);
    const json = JSON.stringify(packed);
    expect(json.length).toBeLessThanOrEqual(2_000);
    expect(json.startsWith("{")).toBe(true);
    expect(json.endsWith("}")).toBe(true);
    expect(packed.unavailable).toEqual(["Slow"]);
  });
});
