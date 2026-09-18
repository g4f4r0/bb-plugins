import * as crypto from "node:crypto";
import { auth, extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

export interface OAuthCredentialRecord {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  state?: string;
  authorizationUrl?: string;
  discoveryState?: OAuthDiscoveryState;
  authorizationServerUrl?: string;
  resourceUrl?: string;
  redirectUri?: string;
}

export interface OAuthCredentialStore {
  get(key: string): Promise<OAuthCredentialRecord | undefined>;
  set(key: string, value: OAuthCredentialRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OAuthCredentialBackend {
  load(): Promise<Record<string, OAuthCredentialRecord>>;
  save(value: Record<string, OAuthCredentialRecord>): Promise<void>;
}

/**
 * Durable OAuth storage needs one small host integration seam: BB's settings
 * writer is an HTTP request, and calling it while the OAuth callback route is
 * still running can deadlock a serialized plugin worker. Keep callback-leg
 * mutations in memory, then flush them after the route has returned.
 */
export class DeferredOAuthCredentialStore implements OAuthCredentialStore {
  private cached: Record<string, OAuthCredentialRecord> | undefined;
  private dirty = false;
  private callbackDepth = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private persistFailures = 0;
  private disposed = false;
  private loading: Promise<Record<string, OAuthCredentialRecord>> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly backend: OAuthCredentialBackend,
    private readonly onPersistError: (error: unknown) => void = () => {},
  ) {}

  async get(key: string): Promise<OAuthCredentialRecord | undefined> {
    const records = await this.readAll();
    const value = records[key];
    return value ? cloneRecord(value) : undefined;
  }

  async set(key: string, value: OAuthCredentialRecord): Promise<void> {
    await this.mutate((records) => { records[key] = cloneRecord(value); });
  }

  async delete(key: string): Promise<void> {
    await this.mutate((records) => { delete records[key]; });
  }

  /** Defer host settings writes until the returned release function is called. */
  deferPersistence(): () => void {
    this.callbackDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.callbackDepth = Math.max(0, this.callbackDepth - 1);
      if (this.callbackDepth === 0 && this.dirty) this.scheduleFlush();
    };
  }

  async flush(): Promise<void> {
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.persistIfSafe());
    await this.writeChain;
  }

  private async mutate(mutator: (records: Record<string, OAuthCredentialRecord>) => void): Promise<void> {
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const records = await this.readAll();
      mutator(records);
      this.cached = records;
      this.dirty = true;
      await this.persistIfSafe();
    });
    await this.writeChain;
  }

  private async readAll(): Promise<Record<string, OAuthCredentialRecord>> {
    if (!this.cached) {
      this.loading ??= this.backend.load().then(cloneRecords);
      try { this.cached ??= await this.loading; }
      finally { this.loading = undefined; }
    }
    return cloneRecords(this.cached);
  }

  private async persistIfSafe(): Promise<void> {
    if (this.disposed || this.callbackDepth > 0 || !this.dirty || !this.cached) return;
    const snapshot = cloneRecords(this.cached);
    this.dirty = false;
    try {
      await this.backend.save(snapshot);
      this.persistFailures = 0;
    } catch (error) {
      this.dirty = true;
      if (++this.persistFailures <= 5) this.scheduleFlush(Math.min(1000 * 2 ** (this.persistFailures - 1), 16000));
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private scheduleFlush(delayMs = 0): void {
    if (this.disposed || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((error) => this.onPersistError(error));
    }, delayMs);
    this.flushTimer.unref?.();
  }
}

function cloneRecord(value: OAuthCredentialRecord): OAuthCredentialRecord {
  return JSON.parse(JSON.stringify(value)) as OAuthCredentialRecord;
}

function cloneRecords(value: Record<string, OAuthCredentialRecord>): Record<string, OAuthCredentialRecord> {
  return JSON.parse(JSON.stringify(value)) as Record<string, OAuthCredentialRecord>;
}

const credentialWrites = new WeakMap<OAuthCredentialStore, Map<string, Promise<unknown>>>();

export type OAuthStatus = "unauthenticated" | "authorizing" | "authenticated";

export const OAUTH_CLIENT_NAME = "BB";

function randomState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function sameString(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * The official MCP SDK owns discovery, PKCE, token exchange, refresh, and
 * WWW-Authenticate handling. This provider only gives it durable, per-server
 * storage and a BB OAuth redirect.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private authorizationUrl: string | undefined;
  private authorization: Promise<void> | undefined;

  constructor(
    private readonly key: string,
    private readonly serverUrl: URL,
    private readonly redirectUrlValue: URL,
    private readonly store: OAuthCredentialStore,
  ) {}

  get redirectUrl(): URL { return this.redirectUrlValue; }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: OAUTH_CLIENT_NAME,
      redirect_uris: [this.redirectUrlValue.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (this.redirectUrlValue.protocol === "https:") {
      metadata.client_uri = this.redirectUrlValue.origin;
    }
    return metadata;
  }

  /**
   * Drop a dynamic client registered against a different callback (loopback
   * vs the public BB URL). Reusing that client_id keeps Notion on 127.0.0.1.
   */
  async alignWithRedirect(): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read();
      const current = this.redirectUrlValue.toString();
      const known = record.redirectUri ?? firstClientRedirect(record.clientInformation);
      if (known === current) {
        if (record.redirectUri !== current) await this.write({ ...record, redirectUri: current });
        return;
      }
      const currentHost = hostnameOf(current);
      const stale =
        Boolean(known && known !== current) ||
        Boolean(!known && (record.clientInformation || record.tokens) && !isLoopbackHost(currentHost));
      if (stale) {
        await this.write({ redirectUri: current });
        this.authorizationUrl = undefined;
        return;
      }
      if (Object.keys(record).length === 0) return;
      await this.write({ ...record, redirectUri: current });
    });
  }

  async state(): Promise<string> {
    return this.mutate(async () => {
      const record = await this.read();
      const value = randomState();
      await this.write({ ...record, state: value });
      return value;
    });
  }

  async clientInformation(ctx?: { issuer: string }): Promise<StoredOAuthClientInformation | undefined> {
    const value = (await this.read()).clientInformation;
    if (ctx?.issuer && value?.issuer && value.issuer.replace(/\/$/, "") !== ctx.issuer.replace(/\/$/, "")) return undefined;
    return value;
  }

  async saveClientInformation(value: StoredOAuthClientInformation): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read();
      await this.write({ ...record, clientInformation: value });
    });
  }

  async tokens(ctx?: { issuer: string }): Promise<StoredOAuthTokens | undefined> {
    const value = (await this.read()).tokens;
    if (ctx?.issuer && value?.issuer && value.issuer.replace(/\/$/, "") !== ctx.issuer.replace(/\/$/, "")) return undefined;
    return value;
  }

  async saveTokens(value: StoredOAuthTokens): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read();
      await this.write({ ...record, tokens: value });
    });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    return this.mutate(async () => {
      this.authorizationUrl = url.toString();
      const record = await this.read();
      await this.write({ ...record, authorizationUrl: this.authorizationUrl });
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read();
      await this.write({ ...record, codeVerifier });
    });
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.read()).codeVerifier;
    if (!value) throw new Error("MCP OAuth code verifier is missing; restart authorization");
    return value;
  }

  async saveAuthorizationServerUrl(value: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read();
      await this.write({ ...record, authorizationServerUrl: value });
    });
  }

  async authorizationServerUrl(): Promise<string | undefined> {
    return (await this.read()).authorizationServerUrl;
  }

  async saveResourceUrl(value: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read();
      await this.write({ ...record, resourceUrl: value });
    });
  }

  async resourceUrl(): Promise<string | undefined> {
    return (await this.read()).resourceUrl;
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read();
      await this.write({ ...record, discoveryState: value });
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read();
      if (scope === "all") {
        await this.store.delete(this.key);
        this.authorizationUrl = undefined;
        return;
      }
      const next = { ...record };
      if (scope === "client") delete next.clientInformation;
      if (scope === "tokens") delete next.tokens;
      if (scope === "verifier") {
        delete next.codeVerifier;
        delete next.state;
      }
      if (scope === "discovery") {
        delete next.discoveryState;
        delete next.authorizationServerUrl;
        delete next.resourceUrl;
      }
      await this.write(next);
    });
  }

  getAuthorizationUrl(): string | undefined { return this.authorizationUrl; }

  async authorizationUrlValue(): Promise<string | undefined> {
    return this.authorizationUrl ?? (await this.read()).authorizationUrl;
  }

  async status(): Promise<OAuthStatus> {
    const record = await this.read();
    if (this.authorizationUrl || record.state) return "authorizing";
    return record.tokens?.access_token ? "authenticated" : "unauthenticated";
  }

  async validateState(value: string | null): Promise<void> {
    const expected = (await this.read()).state;
    if (!sameString(expected, value ?? undefined)) throw new Error("MCP OAuth state mismatch");
  }

  async clearPending(): Promise<void> {
    return this.mutate(async () => {
      this.authorizationUrl = undefined;
      const record = await this.read();
      delete record.state;
      delete record.codeVerifier;
      delete record.authorizationUrl;
      await this.write(record);
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let queues = credentialWrites.get(this.store);
    if (!queues) credentialWrites.set(this.store, queues = new Map());
    const work = (queues.get(this.key) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(this.key, work);
    try { return await work; }
    finally { if (queues.get(this.key) === work) queues.delete(this.key); }
  }

  /** One OAuth exchange per server, including rotating refresh tokens. */
  async reauthorize(response: Response, fetchFn: typeof fetch): Promise<void> {
    if (this.authorization) return this.authorization;
    const work = (async () => {
      let transientError: Error | undefined;
      const guardedFetch: typeof fetch = async (input, init) => {
        try {
          const result = await fetchFn(input, init);
          if (result.status >= 500 || result.status === 429) {
            transientError = new Error(`OAuth service temporarily unavailable (HTTP ${result.status})`);
          }
          return result;
        } catch (error) {
          transientError = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
      };
      // The SDK falls back to consent after transient refresh failures. Keep
      // the durable refresh token and let the next request retry instead.
      const provider = new Proxy(this, {
        get: (target, property) => {
          if (property === "state") return async () => {
            if (transientError) throw transientError;
            return target.state();
          };
          if (property === "redirectToAuthorization") return async (url: URL) => {
            if (transientError) throw transientError;
            await target.redirectToAuthorization(url);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const challenge = extractWWWAuthenticateParams(response);
      const result = await auth(provider, { serverUrl: this.serverUrl, ...challenge, fetchFn: guardedFetch });
      if (result !== "AUTHORIZED") throw new UnauthorizedError();
      await this.clearPending();
    })();
    this.authorization = work;
    try { await work; }
    finally { if (this.authorization === work) this.authorization = undefined; }
  }

  private async read(): Promise<OAuthCredentialRecord> {
    return (await this.store.get(this.key)) ?? {};
  }

  private async write(value: OAuthCredentialRecord): Promise<void> {
    if (Object.keys(value).length === 0) await this.store.delete(this.key);
    else await this.store.set(this.key, value);
  }

  /** Exposed for tests and diagnostics; it never contains an access token. */
  get serverOrigin(): string { return this.serverUrl.origin; }
}

function firstClientRedirect(info: StoredOAuthClientInformation | undefined): string | undefined {
  if (!info || typeof info !== "object") return undefined;
  const uris = (info as { redirect_uris?: unknown }).redirect_uris;
  if (!Array.isArray(uris)) return undefined;
  return uris.find((value): value is string => typeof value === "string" && value.length > 0);
}

function hostnameOf(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

function isLoopbackHost(host: string | null): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
