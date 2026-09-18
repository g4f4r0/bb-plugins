import { describe, expect, it } from "vitest";
import { McpOAuthProvider, type OAuthCredentialRecord, type OAuthCredentialStore } from "./oauth.js";

class MemorySecrets implements OAuthCredentialStore {
  readonly records = new Map<string, OAuthCredentialRecord>();
  async get(key: string) { return this.records.get(key); }
  async set(key: string, value: OAuthCredentialRecord) { this.records.set(key, value); }
  async delete(key: string) { this.records.delete(key); }
}

describe("McpOAuthProvider", () => {
  it("persists PKCE state and credentials without exposing them in status", async () => {
    const secrets = new MemorySecrets();
    const provider = new McpOAuthProvider(
      "plugin:server",
      new URL("https://mcp.example.test/mcp"),
      new URL("http://127.0.0.1:4000/callback?pluginId=plugin&serverId=server"),
      secrets,
    );
    expect(provider.clientMetadata).toEqual(expect.objectContaining({
      client_name: "BB",
      token_endpoint_auth_method: "none",
      redirect_uris: ["http://127.0.0.1:4000/callback?pluginId=plugin&serverId=server"],
    }));
    expect(provider.clientMetadata).not.toHaveProperty("client_uri");
    expect(await provider.status()).toBe("unauthenticated");

    const state = await provider.state();
    await expect(provider.validateState("wrong")).rejects.toThrow("state mismatch");
    await expect(provider.validateState(state)).resolves.toBeUndefined();
    await provider.saveCodeVerifier("verifier");
    await provider.redirectToAuthorization(new URL("https://auth.example.test/authorize?state=" + state));
    expect(await provider.status()).toBe("authorizing");
    expect(provider.getAuthorizationUrl()).toContain("auth.example.test");
    const reloadedProvider = new McpOAuthProvider(
      "plugin:server",
      new URL("https://mcp.example.test/mcp"),
      new URL("http://127.0.0.1:4000/callback?pluginId=plugin&serverId=server"),
      secrets,
    );
    expect(await reloadedProvider.authorizationUrlValue()).toContain("auth.example.test");

    await provider.saveTokens({ access_token: "secret-access-token", token_type: "Bearer", refresh_token: "secret-refresh-token" });
    await provider.clearPending();
    expect(await provider.status()).toBe("authenticated");
    expect(await provider.tokens()).toEqual(expect.objectContaining({ access_token: "secret-access-token" }));

    await provider.invalidateCredentials("tokens");
    expect(await provider.status()).toBe("unauthenticated");
    expect(secrets.records.get("plugin:server")?.codeVerifier).toBeUndefined();
  });

  it("advertises BB and the public origin on HTTPS redirects", () => {
    const provider = new McpOAuthProvider(
      "plugin:server",
      new URL("https://mcp.notion.com/mcp"),
      new URL("https://g4f4r0.getbb.app/api/v1/plugins/mcps/http/oauth/callback?pluginId=com_notion_mcp&serverId=mcp"),
      new MemorySecrets(),
    );
    expect(provider.clientMetadata).toEqual(expect.objectContaining({
      client_name: "BB",
      client_uri: "https://g4f4r0.getbb.app",
    }));
  });

  it("drops a loopback-registered client when the public redirect changes", async () => {
    const secrets = new MemorySecrets();
    await secrets.set("plugin:server", {
      clientInformation: { client_id: "old-client" } as never,
      tokens: { access_token: "old", token_type: "Bearer" },
      redirectUri: "http://127.0.0.1:38886/callback",
    });
    const provider = new McpOAuthProvider(
      "plugin:server",
      new URL("https://mcp.notion.com/mcp"),
      new URL("https://g4f4r0.getbb.app/callback"),
      secrets,
    );
    await provider.alignWithRedirect();
    expect(secrets.records.get("plugin:server")).toEqual({
      redirectUri: "https://g4f4r0.getbb.app/callback",
    });
  });
});

describe("OAuth issuer identity", () => {
  it("accepts a trailing slash difference while rejecting another issuer", async () => {
    const secrets = new MemorySecrets();
    const provider = new McpOAuthProvider("issuer:test", new URL("https://mcp.example/mcp"), new URL("https://bb.example/callback"), secrets);
    await provider.saveTokens({ access_token: "token", token_type: "Bearer", issuer: "https://auth.example" });
    expect(await provider.tokens({ issuer: "https://auth.example/" })).toBeDefined();
    expect(await provider.tokens({ issuer: "https://other.example" })).toBeUndefined();
    await provider.saveClientInformation({ client_id: "client", issuer: "https://auth.example/" });
    expect(await provider.clientInformation({ issuer: "https://auth.example" })).toBeDefined();
    expect(await provider.clientInformation({ issuer: "https://other.example" })).toBeUndefined();
  });
});
