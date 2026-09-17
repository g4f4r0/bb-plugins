import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { directEvent } from "./direct-input";
import { redact } from "./policy";
const controlMessage = z.object({
  seq: z.number().int().safe(),
  events: z.array(directEvent).min(1).max(64),
});
type Message = z.infer<typeof controlMessage>;
/** One authenticated, session-bound input connection; no browser CDP is exposed. */
export async function controlRelay(
  run: (events: Message["events"]) => Promise<unknown>,
  reset: () => Promise<void>,
  onStop: () => void,
) {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const token = randomBytes(32).toString("hex");
  let claimed = false,
    closed = false,
    chain = Promise.resolve();
  let expiry: ReturnType<typeof setTimeout>;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    server.close();
    void chain.finally(() => reset().catch(() => {}));
    onStop();
  };
  server.on("upgrade", (req, socket, head) => {
    if (
      closed ||
      claimed ||
      req.url !== "/control" ||
      req.headers.authorization !== `Bearer ${token}`
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    claimed = true;
    clearTimeout(expiry);
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws, req),
    );
  });
  sockets.on("connection", (ws) => {
    let pending = 0;
    ws.on("message", (raw, binary) => {
      if (closed) return;
      if (binary || String(raw).length > 65536 || pending >= 4) {
        ws.close(1008, "Input queue exceeded");
        return;
      }
      let message: Message;
      try {
        message = controlMessage.parse(JSON.parse(String(raw)));
      } catch {
        ws.close(1008, "Invalid input");
        return;
      }
      pending++;
      chain = chain.then(async () => {
        try {
          if (closed) return;
          const result = await run(message.events);
          if (!closed)
            ws.send(
              JSON.stringify({ seq: message.seq, ...(result as object) }),
            );
        } catch (e) {
          if (!closed)
            ws.send(
              JSON.stringify({ seq: message.seq, error: redact(String(e)) }),
            );
        } finally {
          pending--;
        }
      });
    });
    ws.on("close", stop);
    ws.on("error", stop);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }).catch((e) => {
    stop();
    throw e;
  });
  expiry = setTimeout(stop, 3000);
  expiry.unref();
  return { port: (server.address() as { port: number }).port, token, stop };
}
export async function connectControlRelay(endpoint: {
  port: number;
  token: string;
}) {
  const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}/control`, {
    headers: { Authorization: `Bearer ${endpoint.token}` },
    handshakeTimeout: 700,
    maxPayload: 256 * 1024,
  });
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("Input connection closed"));
    }
    pending.clear();
  };
  ws.on("close", fail);
  ws.on("error", fail);
  ws.on("message", (raw, binary) => {
    if (binary) {
      ws.close();
      return;
    }
    try {
      const result = JSON.parse(String(raw));
      const p = pending.get(result.seq);
      if (!p) return;
      pending.delete(result.seq);
      clearTimeout(p.timer);
      p.resolve(result);
    } catch {
      ws.close();
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", (e) => {
      ws.terminate();
      reject(e);
    });
  });
  return {
    close: () => ws.close(),
    send: (message: Message) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(Error("Input connection closed"));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(message.seq);
          reject(Error("Input connection timed out"));
          ws.terminate();
        }, 10000);
        pending.set(message.seq, { resolve, reject, timer });
        ws.send(JSON.stringify(message));
      }),
  };
}
