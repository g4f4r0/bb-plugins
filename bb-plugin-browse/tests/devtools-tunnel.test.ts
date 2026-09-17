import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  assertAssetPath,
  assertTargetId,
  assetContentType,
  debugPortFromEndpoint,
  fetchDevtoolsAsset,
  openDevtoolsTunnel,
  pageTargetUrl,
} from "../src/devtools-tunnel";

describe("devtools endpoint helpers", () => {
  it("parses the loopback debugger port", () => {
    expect(
      debugPortFromEndpoint("ws://127.0.0.1:18993/devtools/browser/abc"),
    ).toBe(18993);
    expect(debugPortFromEndpoint("ws://10.0.0.1:9222/devtools/browser/x")).toBe(
      undefined,
    );
    expect(debugPortFromEndpoint("")).toBe(undefined);
  });
  it("builds the page target url", () => {
    expect(pageTargetUrl(18993, "abc123")).toBe(
      "ws://127.0.0.1:18993/devtools/page/abc123",
    );
  });
  it("rejects traversal asset paths", () => {
    expect(() => assertAssetPath("../secret")).toThrow();
    expect(() => assertAssetPath("/absolute")).toThrow();
    expect(() => assertAssetPath("a/./b")).toThrow();
    expect(() => assertAssetPath("")).toThrow();
    expect(() => assertAssetPath("entrypoints/inspector/inspector.js")).not.toThrow();
  });
  it("rejects bad target ids", () => {
    expect(() => assertTargetId("ABCDEF123456")).not.toThrow();
    expect(() => assertTargetId("../../etc")).toThrow();
    expect(() => assertTargetId("a/b")).toThrow();
    expect(() => assertTargetId("")).toThrow();
  });
  it("maps frontend content types", () => {
    expect(assetContentType("inspector.html")).toContain("text/html");
    expect(assetContentType("bundle.js")).toContain("javascript");
    expect(assetContentType("style.css")).toContain("text/css");
  });
});

describe("devtools asset fetch", () => {
  it("proxies bytes with a mapped content type", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/devtools/entrypoints/app.js") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("console.log(1)");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const asset = await fetchDevtoolsAsset(port, "entrypoints/app.js");
      expect(asset.contentType).toContain("javascript");
      expect(asset.data.toString()).toBe("console.log(1)");
      await expect(fetchDevtoolsAsset(port, "missing.js")).rejects.toThrow();
      await expect(fetchDevtoolsAsset(port, "../escape")).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});

describe("devtools tunnel", () => {
  it("routes responses by id and buffers events", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (!req.url?.startsWith("/devtools/page/")) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws);
      });
    });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({ id: message.id, result: { echoed: message.method } }),
        );
        ws.send(JSON.stringify({ method: "Page.loadEventFired", params: {} }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const tunnel = await openDevtoolsTunnel(port, "ABCDEF123456", "client-1");
    try {
      expect(tunnel.closed).toBe(false);
      const response = await tunnel.send(
        JSON.stringify({ id: 7, method: "Page.enable" }),
      );
      expect(JSON.parse(response)).toMatchObject({
        id: 7,
        result: { echoed: "Page.enable" },
      });
      await new Promise((r) => setTimeout(r, 50));
      const events = tunnel.poll();
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!).method).toBe("Page.loadEventFired");
      await expect(tunnel.send("not-json")).rejects.toThrow();
      await expect(
        tunnel.send(JSON.stringify({ method: "NoId" })),
      ).rejects.toThrow();
    } finally {
      tunnel.close();
      expect(tunnel.closed).toBe(true);
      await expect(
        tunnel.send(JSON.stringify({ id: 8, method: "Page.enable" })),
      ).rejects.toThrow();
      wss.close();
      server.close();
    }
  });
});
