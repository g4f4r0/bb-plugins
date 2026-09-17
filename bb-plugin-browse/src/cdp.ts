import WebSocket from "ws";
import { streamProfiles } from "./adaptive-stream";

type LiveFrame = {
  data: string;
  width: number;
  height: number;
  seq: number;
};

export function liveFrameFromEvent(params: any, seq: number): LiveFrame {
  const md = params?.metadata ?? {};
  const width = Math.round(Number(md.deviceWidth)) || 1280;
  const height = Math.round(Number(md.deviceHeight)) || 800;
  return {
    data: String(params?.data ?? ""),
    width: Math.min(8192, Math.max(1, width)),
    height: Math.min(8192, Math.max(1, height)),
    seq,
  };
}

export class Cdp {
  private ws: WebSocket;
  private serial = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(method: string, params: any) => void>();
  onEvent(fn: (method: string, params: any) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  onDisconnect?: () => void;
  private frameListener?: (params: any) => void;
  private frameFailure?: () => void;
  private casting = false;
  private streamTier = 0;
  private configuring?: Promise<void>;
  private seq = 0;
  private latest?: LiveFrame;
  private liveAcks: number[] = [];
  private lastFrameDemand = 0;
  private restartingCast?: Promise<void>;
  private acknowledgeLiveFrames() {
    const ids = this.liveAcks;
    this.liveAcks = [];
    for (const sessionId of ids) void this.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  }
  private waiters = new Set<{
    after: number;
    resolve: (f: LiveFrame) => void;
    reject: (e: Error) => void;
  }>();
  sessionId?: string;
  targetId?: string;
  private constructor(endpoint: string) {
    this.ws = new WebSocket(endpoint, { maxPayload: 40 * 1024 * 1024 });
    this.ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        (m.method === "Target.detachedFromTarget" &&
          m.params?.sessionId === this.sessionId) ||
        (m.method === "Target.targetDestroyed" &&
          m.params?.targetId === this.targetId)
      ) {
        this.fail();
      }
      if (m.method)
        for (const listener of this.listeners) listener(m.method, m.params);
      if (m.method === "Page.screencastFrame") this.onScreencast(m.params);
      const p = this.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        if (
          m.error &&
          /session with given id not found|no target with given id/i.test(
            m.error.message,
          )
        )
          this.fail();
      }
    });
    this.ws.on("close", () => this.fail());
    this.ws.on("error", () => this.fail());
  }
  static async connect(endpoint: string, managed = false, waitForPage = false, initialUrl = "about:blank"): Promise<Cdp> {
    const c = new Cdp(endpoint);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        c.close();
        reject(new Error("Browser connection timed out"));
      }, 10000);
      c.ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      c.ws.once("error", () => {
        clearTimeout(t);
        reject(
          new Error(
            "Browser connection unavailable. Reconnect the desktop session.",
          ),
        );
      });
    });
    try {
      let pages: any[] = [], deadline = Date.now() + 5000;
      let startupPage: any | undefined;
      do {
        const { targetInfos } = await c.send("Target.getTargets", {}, false);
        pages = targetInfos.filter(
          (t: any) => t.type === "page" || t.type === "webview",
        );
        if (waitForPage && initialUrl !== "about:blank") {
          const nonBlank = pages.filter(
            (page: any) => page.url && page.url !== "about:blank",
          );
          startupPage =
            nonBlank.find((page: any) => page.url === initialUrl) ??
            (nonBlank.length === 1 ? nonBlank[0] : undefined);
          if (startupPage) break;
        } else if (pages.length || !waitForPage) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      } while (Date.now() < deadline);
      if (managed) {
        // Managed profiles may restore old tabs after a crash. Own a fresh target explicitly.
        const fresh = await c.send(
          "Target.createTarget",
          { url: initialUrl },
          false,
        );
        c.targetId = fresh.targetId;
        for (const page of pages)
          await c.send(
            "Target.closeTarget",
            { targetId: page.targetId },
            false,
          );
      } else {
        if (startupPage) {
          c.targetId = startupPage.targetId;
        } else if (pages.length !== 1) {
          throw new Error(`Expected one leased tab; found ${pages.length}.`);
        } else {
          c.targetId = pages[0].targetId;
        }
      }
      const r = await c.send(
        "Target.attachToTarget",
        { targetId: c.targetId, flatten: true },
        false,
      );
      c.sessionId = r.sessionId;
      return c;
    } catch (e) {
      c.close();
      throw e;
    }
  }
  send(
    method: string,
    params: Record<string, unknown> = {},
    page = true,
    timeoutMs = 15000,
  ): Promise<any> {
    return this.sendWithSession(
      method,
      params,
      page && this.sessionId ? this.sessionId : undefined,
      timeoutMs,
    );
  }
  sendToSession(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
    timeoutMs = 15000,
  ): Promise<any> {
    return this.sendWithSession(method, params, sessionId, timeoutMs);
  }
  private sendWithSession(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    timeoutMs: number,
  ): Promise<any> {
    if (this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error("Browser disconnected; reconnect this session."),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  async evaluate(expression: string, timeoutMs = 15000) {
    const r = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      true,
      timeoutMs,
    );
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
      );
    return r.result.value;
  }
  private onScreencast(params: any) {
    if (this.casting) {
      // Preserve a short capture pipeline for active viewers, then withhold
      // credit when consumers stop reading. IDs repeat across frames, so each
      // event must retain its own acknowledgement; never deduplicate them.
      this.liveAcks.push(params.sessionId);
      this.latest = liveFrameFromEvent(params, ++this.seq);
      if (Date.now() - this.lastFrameDemand < 50) this.acknowledgeLiveFrames();
      for (const w of [...this.waiters])
        if (this.latest.seq > w.after) {
          this.waiters.delete(w);
          this.acknowledgeLiveFrames();
          w.resolve(this.latest);
        }
      return;
    }
    this.frameListener?.(params);
  }
  async configureLiveCast(tier: number) {
    while (this.configuring) await this.configuring;
    if (this.streamTier === tier) return;
    this.configuring = (async () => {
      if (this.restartingCast) await this.restartingCast;
      await this.stopLiveCast();
      this.streamTier = tier;
      this.latest = undefined;
      await this.startLiveCast();
    })();
    try { await this.configuring; } finally { this.configuring = undefined; }
  }
  async startLiveCast() {
    if (this.casting) return;
    this.casting = true;
    try {
      await this.send("Page.startScreencast", {
        format: "jpeg",
        ...streamProfiles[this.streamTier ?? 0],
        everyNthFrame: 1,
      });
    } catch (e) {
      this.casting = false;
      throw e;
    }
  }
  async stopLiveCast() {
    if (!this.casting) return;
    this.casting = false;
    this.acknowledgeLiveFrames();
    await this.send("Page.stopScreencast").catch(() => {});
  }
  async refreshLiveCast() {
    while (this.configuring) await this.configuring;
    if (this.restartingCast) await this.restartingCast;
    if (!this.casting) return;
    this.restartingCast = (async () => {
      await this.stopLiveCast();
      this.latest = undefined;
      await this.startLiveCast();
    })().finally(() => { this.restartingCast = undefined; });
    await this.restartingCast;
  }
  async nextLiveFrame(after = 0, timeoutMs = 8000): Promise<LiveFrame> {
    while (this.configuring) await this.configuring;
    const now = Date.now();
    const resume = this.casting && this.liveAcks.length > 0 && now - this.lastFrameDemand > 250;
    this.lastFrameDemand = now;
    // Withheld frames can predate a static page change. Restarting requests a
    // fresh compositor image even when the page produces no further damage.
    if (resume && !this.restartingCast) {
      this.restartingCast = (async () => {
        await this.stopLiveCast();
        this.latest = undefined;
        await this.startLiveCast();
      })().finally(() => { this.restartingCast = undefined; });
    }
    if (this.restartingCast) await this.restartingCast;
    if (!this.casting) await this.startLiveCast();
    this.acknowledgeLiveFrames();
    if (this.latest && this.latest.seq > after) return this.latest;
    return new Promise((resolve, reject) => {
      const waiter = { after, resolve, reject };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        if (this.latest) resolve(this.latest);
        else
          reject(
            new Error(
              "No live frame arrived. The browser may not be rendering; check its session and host.",
            ),
          );
      }, timeoutMs);
      waiter.resolve = (f) => {
        clearTimeout(timer);
        resolve(f);
      };
      waiter.reject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      this.waiters.add(waiter);
    });
  }
  async captureFrame(): Promise<string> {
    const resume = this.casting;
    if (resume) await this.stopLiveCast();
    let timer: ReturnType<typeof setTimeout>;
    const frame = new Promise<any>((resolve, reject) => {
      this.frameListener = resolve;
      this.frameFailure = () =>
        reject(new Error("Browser disconnected during capture"));
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "No screenshot frame arrived. Keep this thread and its native browser tab visible in BB Desktop.",
            ),
          ),
        6000,
      );
    });
    void frame.catch(() => {});
    try {
      await this.send("Page.startScreencast", {
        format: "png",
        everyNthFrame: 1,
      });
      const result = await frame;
      await this.send("Page.screencastFrameAck", {
        sessionId: result.sessionId,
      });
      return result.data;
    } finally {
      clearTimeout(timer!);
      this.frameListener = undefined;
      this.frameFailure = undefined;
      await this.send("Page.stopScreencast").catch(() => {});
      if (resume) await this.startLiveCast().catch(() => {});
    }
  }
  private fail() {
    this.onDisconnect?.();
    this.onDisconnect = undefined;
    this.frameFailure?.();
    this.liveAcks = [];
    this.casting = false;
    for (const w of this.waiters)
      w.reject(
        new Error(
          "Browser control disconnected or its tab closed. Inspect the session before reconnecting.",
        ),
      );
    this.waiters.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new Error(
          "Browser control disconnected or its tab closed. Inspect the session before reconnecting.",
        ),
      );
    }
    this.pending.clear();
  }
  close() {
    this.fail();
    this.ws.terminate();
  }
}
