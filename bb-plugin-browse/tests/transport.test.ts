import { describe, it, expect } from "vitest";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { Bridge } from "../src/bridge";
import { validateCommand, redact } from "../src/policy";
import { runProcess } from "../src/process";
describe("private CDP adapter", () => {
  it("multiplexes overlapping request IDs and blocks closing the user browser", async () => {
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(upstream, "listening");
    upstream.on("connection", (ws) =>
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        ws.send(JSON.stringify({ id: m.id, result: { echo: m.params.value } }));
      }),
    );
    const addr = upstream.address() as { port: number };
    const b = await Bridge.open(`ws://127.0.0.1:${addr.port}`);
    const a = new WebSocket(b.endpoint),
      c = new WebSocket(b.endpoint);
    await Promise.all([once(a, "open"), once(c, "open")]);
    const ar = once(a, "message"),
      cr = once(c, "message");
    a.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { value: "first" },
      }),
    );
    c.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { value: "second" },
      }),
    );
    expect(JSON.parse((await ar)[0].toString()).result.echo).toBe("first");
    expect(JSON.parse((await cr)[0].toString()).result.echo).toBe("second");
    const blocked = once(a, "message");
    a.send(JSON.stringify({ id: 2, method: "Browser.close" }));
    expect(JSON.parse((await blocked)[0].toString()).error).toBeTruthy();
    a.terminate();
    c.terminate();
    b.close();
    for (const ws of upstream.clients) ws.terminate();
    await new Promise<void>((r) => upstream.close(() => r()));
  });
});
describe("command boundaries", () => {
  it("does not accept runtime switching or expose CDP endpoints", () => {
    expect(() => validateCommand(["click", "@e1", "--cdp=9222"])).toThrow();
    expect(() => validateCommand(["connect", "9222"])).toThrow();
    expect(() => validateCommand(["get", "cdp-url"])).toThrow();
    expect(() => validateCommand(["fill", "@e1", "hello"])).not.toThrow();
  });
  it("redacts browser credentials from errors", () => {
    expect(redact("failed ws://127.0.0.1:999/token-secret")).not.toContain(
      "token-secret",
    );
  });
  it("executes argument arrays without a shell", async () => {
    const text = "$(touch /tmp/should-not-exist); `id`";
    expect(
      await runProcess(process.execPath, [
        "-e",
        "process.stdout.write(process.argv[1])",
        text,
      ]),
    ).toBe(text);
  });
  it("interrupts a running child", async () => {
    const c = new AbortController();
    const p = runProcess(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
      signal: c.signal,
    });
    c.abort();
    await expect(p).rejects.toThrow("Cancelled");
  });
});
it("preserves Unicode characters split across subprocess output chunks", async () => {
  const value = await runProcess(process.execPath, [
    "-e",
    "const b=Buffer.from('✓👋');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1,4)),30);setTimeout(()=>process.stdout.write(b.subarray(4)),60)",
  ]);
  expect(value).toBe("✓👋");
});
it("enforces output limits in bytes and reports the actual configured limit", async () => {
  await expect(
    runProcess(
      process.execPath,
      ["-e", "process.stdout.write('👋'.repeat(100))"],
      { limit: 100 },
    ),
  ).rejects.toThrow("100 bytes");
});

it("reconnects managed profiles with restored tabs but keeps native leases strict", async () => {
  const { Cdp } = await import("../src/cdp");
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const calls: any[] = [];
  upstream.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      calls.push(m);
      const result =
        m.method === "Target.getTargets"
          ? {
              targetInfos: [
                { type: "page", targetId: "restored" },
                { type: "page", targetId: "blank" },
              ],
            }
          : m.method === "Target.createTarget"
            ? { targetId: "fresh" }
            : m.method === "Target.attachToTarget"
              ? { sessionId: "attached" }
              : {};
      ws.send(JSON.stringify({ id: m.id, result }));
    }),
  );
  const endpoint = `ws://127.0.0.1:${(upstream.address() as any).port}`;
  try {
    await expect(Cdp.connect(endpoint)).rejects.toThrow(
      "Expected one leased tab",
    );
    expect(calls.some((c) => c.method === "Target.createTarget")).toBe(false);
    const c = await Cdp.connect(endpoint, true, false, "https://example.com/ready");
    expect(c.targetId).toBe("fresh");
    expect(calls.find((call) => call.method === "Target.createTarget")?.params).toEqual({
      url: "https://example.com/ready",
    });
    expect(
      calls
        .filter((c) => c.method === "Target.closeTarget")
        .map((c) => c.params.targetId),
    ).toEqual(["restored", "blank"]);
    c.close();
  } finally {
    for (const ws of upstream.clients) ws.terminate();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

it("waits for the managed video page without weakening native tab checks", async () => {
  const { Cdp } = await import("../src/cdp");
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  let reads = 0;
  upstream.on("connection", (ws) => ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    const result = m.method === "Target.getTargets"
      ? { targetInfos: ++reads < 3
        ? [{ type: "page", targetId: "temporary", url: "about:blank" }]
        : [{ type: "page", targetId: "video-page", url: "https://example.com/ready" }] }
      : m.method === "Target.attachToTarget" ? { sessionId: "attached" } : {};
    ws.send(JSON.stringify({ id: m.id, result }));
  }));
  const endpoint = `ws://127.0.0.1:${(upstream.address() as any).port}`;
  try {
    const c = await Cdp.connect(
      endpoint,
      false,
      true,
      "https://example.com/ready",
    );
    expect(c.targetId).toBe("video-page");
    expect(reads).toBe(3);
    c.close();
  } finally {
    for (const ws of upstream.clients) ws.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("reports a detached page even when the browser websocket remains connected", async () => {
  const { Cdp } = await import("../src/cdp");
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  let socket: WebSocket | undefined;
  upstream.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          id: m.id,
          result:
            m.method === "Target.getTargets"
              ? { targetInfos: [{ type: "page", targetId: "page" }] }
              : { sessionId: "page-session" },
        }),
      );
    });
  });
  let c: Awaited<ReturnType<typeof Cdp.connect>> | undefined;
  try {
    c = await Cdp.connect(`ws://127.0.0.1:${(upstream.address() as any).port}`);
    const disconnected = new Promise<void>((resolve) => {
      c!.onDisconnect = resolve;
    });
    socket!.send(
      JSON.stringify({
        method: "Target.detachedFromTarget",
        params: { sessionId: "page-session", targetId: "page" },
      }),
    );
    await disconnected;
    expect(socket!.readyState).toBe(WebSocket.OPEN);
  } finally {
    c?.close();
    for (const ws of upstream.clients) ws.terminate();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
