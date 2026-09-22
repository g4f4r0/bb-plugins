import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInfisicalClient } from "../../src/core/infisical.js";

const FAKE_BIN = fileURLToPath(new URL("../fixtures/fake-infisical.mjs", import.meta.url));
const SCOPE = { projectId: "proj_test", env: "prod", path: "/" };

describe("Infisical client (against a fake CLI, never the real project)", () => {
  beforeEach(() => {
    delete process.env.FAKE_INFISICAL_FAIL;
    delete process.env.FAKE_INFISICAL_SECRETS;
  });
  afterEach(() => {
    delete process.env.FAKE_INFISICAL_FAIL;
    delete process.env.FAKE_INFISICAL_SECRETS;
  });

  it("resolves a configured secret's value without shelling it out as an argument", async () => {
    process.env.FAKE_INFISICAL_SECRETS = JSON.stringify({ OPENROUTER_API_KEY: "sk-test-value" });
    const client = createInfisicalClient(FAKE_BIN, 5_000);
    const value = await client.resolveSecret(SCOPE, "OPENROUTER_API_KEY");
    expect(value).toBe("sk-test-value");
  });

  it("reports missing when the named secret is absent", async () => {
    process.env.FAKE_INFISICAL_SECRETS = JSON.stringify({});
    const client = createInfisicalClient(FAKE_BIN, 5_000);
    expect(await client.resolveSecret(SCOPE, "OPENROUTER_API_KEY")).toBeNull();
    expect(await client.secretConfigured(SCOPE, "OPENROUTER_API_KEY")).toBe(false);
  });

  it("secretConfigured is true only when a value resolves, and never exposes it", async () => {
    process.env.FAKE_INFISICAL_SECRETS = JSON.stringify({ TYPESAFE_API_KEY: "typesafe-secret" });
    const client = createInfisicalClient(FAKE_BIN, 5_000);
    const configured = await client.secretConfigured(SCOPE, "TYPESAFE_API_KEY");
    expect(configured).toBe(true);
  });

  it("reports blocked (not configured) when the CLI call fails, e.g. an unauthorized/unverified scope", async () => {
    process.env.FAKE_INFISICAL_FAIL = "1";
    const client = createInfisicalClient(FAKE_BIN, 5_000);
    expect(await client.resolveSecret(SCOPE, "OPENROUTER_API_KEY")).toBeNull();
    expect(await client.secretConfigured(SCOPE, "OPENROUTER_API_KEY")).toBe(false);
  });

  it("writes a secret through a private 0600 temp file referenced by path, never as a CLI argument, and deletes it after", async () => {
    const capturePath = join(tmpdir(), `wf-capture-${randomUUID()}.json`);
    process.env.FAKE_INFISICAL_CAPTURE = capturePath;
    try {
      const client = createInfisicalClient(FAKE_BIN, 5_000);
      const ok = await client.setSecret(SCOPE, "OPENROUTER_API_KEY", "sk-should-not-appear-in-argv");
      expect(ok).toBe(true);
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as { args: string[]; filePath: string };
      const assignment = captured.args[2];
      expect(assignment).toMatch(/^OPENROUTER_API_KEY=@/u);
      expect(assignment).not.toContain("sk-should-not-appear-in-argv");
      // The file the fake CLI read from is gone once setSecret returns.
      await expect(readFile(captured.filePath, "utf8")).rejects.toThrow();
    } finally {
      await rm(capturePath, { force: true });
      delete process.env.FAKE_INFISICAL_CAPTURE;
    }
  });

  it("setSecret fails cleanly when the CLI rejects the write", async () => {
    process.env.FAKE_INFISICAL_FAIL = "1";
    const client = createInfisicalClient(FAKE_BIN, 5_000);
    expect(await client.setSecret(SCOPE, "OPENROUTER_API_KEY", "sk-value")).toBe(false);
  });

  it("testProviderKey reports readiness status without ever including the key value", async () => {
    process.env.FAKE_INFISICAL_SECRETS = JSON.stringify({ OPENROUTER_API_KEY: "sk-probe" });
    const client = createInfisicalClient(FAKE_BIN, 5_000);
    const server = await startProbeServer((request) => {
      expect(request.headers.get("authorization")).toBe("Bearer sk-probe");
      return new Response(null, { status: 200 });
    });
    try {
      const result = await client.testProviderKey(SCOPE, "OPENROUTER_API_KEY", server.url, "authorization");
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(JSON.stringify(result)).not.toContain("sk-probe");
    } finally {
      server.close();
    }
  });

  it("testProviderKey reports missing without calling out when the secret is unset", async () => {
    process.env.FAKE_INFISICAL_SECRETS = JSON.stringify({});
    const client = createInfisicalClient(FAKE_BIN, 5_000);
    const result = await client.testProviderKey(SCOPE, "OPENROUTER_API_KEY", "http://127.0.0.1:1/unused", "authorization");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("missing");
  });
});

async function startProbeServer(handle: (request: Request) => Response): Promise<{ url: string; close: () => void }> {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const result = handle(new Request(`http://127.0.0.1${request.url}`, { headers: request.headers as never }));
    response.writeHead(result.status);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}
