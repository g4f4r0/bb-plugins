import WebSocket from "ws";

/**
 * Undocked DevTools: a raw CDP pipe to the page target plus proxied frontend
 * assets. The host always reaches its own browser over loopback, so this
 * works uniformly no matter where the plugin server runs.
 */

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 400;
const MESSAGE_TIMEOUT_MS = 20000;

export function debugPortFromEndpoint(
  endpoint: string,
): number | undefined {
  const match = /^ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//.exec(
    endpoint,
  );
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port > 0 && port < 65536
    ? port
    : undefined;
}

export function pageTargetUrl(port: number, targetId: string): string {
  return `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
}

export function assertTargetId(targetId: string): void {
  if (!/^[\w-]{1,128}$/.test(targetId))
    throw new Error("Unknown browser target.");
}

export function assertAssetPath(path: string): void {
  if (
    !path ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  )
    throw new Error("Invalid DevTools asset path.");
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..")
      throw new Error("Invalid DevTools asset path.");
  }
}

export function assetContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
    case "map":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "woff2":
      return "font/woff2";
    case "wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

export async function fetchDevtoolsAsset(
  port: number,
  path: string,
): Promise<{ data: Buffer; contentType: string }> {
  assertAssetPath(path);
  const response = await fetch(`http://127.0.0.1:${port}/devtools/${path}`);
  if (!response.ok)
    throw new Error(`DevTools asset unavailable (${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0 || data.length > MAX_ASSET_BYTES)
    throw new Error("DevTools asset exceeds the size budget.");
  return { data, contentType: assetContentType(path) };
}

export type DevtoolsTunnel = {
  clientId: string;
  closed: boolean;
  send: (message: string) => Promise<string>;
  poll: () => string[];
  close: () => void;
};

/** Open a dedicated pipe to the page target. Responses route by CDP id. */
export function openDevtoolsTunnel(
  port: number,
  targetId: string,
  clientId: string,
): Promise<DevtoolsTunnel> {
  assertTargetId(targetId);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(pageTargetUrl(port, targetId), {
      handshakeTimeout: 5000,
      maxPayload: 8 * 1024 * 1024,
    });
    let opened = false;
    const events: string[] = [];
    const pending = new Map<
      number,
      {
        resolve: (response: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const tunnel: DevtoolsTunnel = {
      clientId,
      closed: false,
      send,
      poll,
      close,
    };
    const fail = (error: Error) => {
      if (tunnel.closed) return;
      tunnel.closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      try {
        ws.close();
      } catch {
        /* Already gone. */
      }
    };
    function send(message: string): Promise<string> {
      if (tunnel.closed)
        return Promise.reject(new Error("DevTools connection closed."));
      let parsed: { id?: unknown };
      try {
        parsed = JSON.parse(message) as { id?: unknown };
      } catch {
        return Promise.reject(new Error("Invalid DevTools message."));
      }
      if (
        !parsed ||
        typeof parsed.id !== "number" ||
        !Number.isSafeInteger(parsed.id)
      )
        return Promise.reject(
          new Error("DevTools messages require a numeric id."),
        );
      if (pending.has(parsed.id))
        return Promise.reject(new Error("Duplicate DevTools message id."));
      return new Promise<string>((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(parsed.id as number);
          rej(new Error("DevTools message timed out."));
        }, MESSAGE_TIMEOUT_MS);
        pending.set(parsed.id as number, {
          resolve: res,
          reject: rej,
          timer,
        });
        ws.send(message, (error) => {
          if (error) {
            clearTimeout(timer);
            pending.delete(parsed.id as number);
            rej(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        });
      });
    }
    function poll(): string[] {
      return events.splice(0);
    }
    function close(): void {
      fail(new Error("DevTools connection closed."));
    }
    ws.on("open", () => {
      opened = true;
      resolve(tunnel);
    });
    ws.on("error", (error) => {
      const cause =
        error instanceof Error ? error : new Error(String(error));
      if (!opened) {
        try {
          ws.terminate();
        } catch {
          /* Already gone. */
        }
        reject(cause);
      } else fail(cause);
    });
    ws.on("close", () => fail(new Error("DevTools connection closed.")));
    ws.on("message", (raw) => {
      const text = String(raw);
      if (text.length > 4 * 1024 * 1024) return;
      let parsed: { id?: unknown };
      try {
        parsed = JSON.parse(text) as { id?: unknown };
      } catch {
        return;
      }
      if (parsed && typeof parsed.id === "number") {
        const entry = pending.get(parsed.id);
        if (!entry) return;
        pending.delete(parsed.id);
        clearTimeout(entry.timer);
        entry.resolve(text);
        return;
      }
      events.push(text);
      if (events.length > MAX_EVENTS)
        events.splice(0, events.length - MAX_EVENTS);
    });
  });
}
