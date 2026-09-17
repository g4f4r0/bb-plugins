import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import type { DirectEvent } from "./direct-input";
import { spawnWatched } from "./watched-process";

/** Private encoder connection; display input is enabled only for docked browser UI. */
export class SelkiesStream {
  onStop?: () => void;
  get isClosed() {
    return this.closed;
  }
  private child?: ChildProcess;
  get processId() {
    return this.child?.pid;
  }
  private socket?: WebSocket;
  private inputOwner?: string;
  private inputBusy = false;
  private inputButtons = new Set<"left" | "middle" | "right">();
  private inputKeys = new Set<number>();
  private inputPoint = { x: 0, y: 0 };
  private inputTimer?: ReturnType<typeof setTimeout>;
  get controlBusy() {
    return this.inputBusy;
  }
  get controlHeld() {
    return this.inputButtons.size > 0 || this.inputKeys.size > 0;
  }
  get controlOwner() {
    return this.inputOwner;
  }
  private sendInput(message: string) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error("Live browser input is unavailable.");
    this.socket.send(message);
  }
  private buttonMask() {
    return (
      (this.inputButtons.has("left") ? 1 : 0) |
      (this.inputButtons.has("middle") ? 2 : 0) |
      (this.inputButtons.has("right") ? 4 : 0)
    );
  }
  private keysym(key: string) {
    const special: Record<string, number> = {
      Backspace: 65288,
      Tab: 65289,
      Enter: 65293,
      Shift: 65505,
      Control: 65507,
      Alt: 65513,
      Escape: 65307,
      Home: 65360,
      ArrowLeft: 65361,
      ArrowUp: 65362,
      ArrowRight: 65363,
      ArrowDown: 65364,
      PageUp: 65365,
      PageDown: 65366,
      End: 65367,
      Meta: 65515,
      Delete: 65535,
    };
    return special[key] ?? (Array.from(key).length === 1 ? key.codePointAt(0) : undefined);
  }
  async resetInput(clientId?: string) {
    if (clientId && this.inputOwner && this.inputOwner !== clientId) return;
    clearTimeout(this.inputTimer);
    if (!this.closed && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(`m,${this.inputPoint.x},${this.inputPoint.y},0,0`);
      this.socket.send("kr");
    }
    this.inputButtons.clear();
    this.inputKeys.clear();
    this.inputOwner = undefined;
  }
  /** XTEST input reaches the page through the isolated display. */
  async runInput(clientId: string, events: DirectEvent[]) {
    if (this.inputBusy || (this.inputOwner && this.inputOwner !== clientId))
      throw new Error("Browser is being controlled by another viewer.");
    clearTimeout(this.inputTimer);
    this.inputBusy = true;
    this.inputOwner = clientId;
    try {
      for (const event of events) {
        if (event.kind === "reset") {
          await this.resetInput(clientId);
          continue;
        }
        if (event.kind === "heartbeat") continue;
        if (event.kind === "pointer") {
          this.inputPoint = { x: Math.round(event.x), y: Math.round(event.y) };
          if (event.type === "down" && event.button !== "none")
            this.inputButtons.add(event.button);
          if (event.type === "up" && event.button !== "none")
            this.inputButtons.delete(event.button);
          this.sendInput(
            `m,${this.inputPoint.x},${this.inputPoint.y},${this.buttonMask()},0`,
          );
          continue;
        }
        if (event.kind === "wheel") {
          this.inputPoint = { x: Math.round(event.x), y: Math.round(event.y) };
          const scroll = (delta: number, bit: number) => {
            if (!delta) return;
            const magnitude = Math.min(64, Math.max(1, Math.ceil(Math.abs(delta) / 100)));
            this.sendInput(
              `m,${this.inputPoint.x},${this.inputPoint.y},${this.buttonMask() | bit},${magnitude}`,
            );
            this.sendInput(
              `m,${this.inputPoint.x},${this.inputPoint.y},${this.buttonMask()},0`,
            );
          };
          scroll(event.deltaY, event.deltaY > 0 ? 16 : 8);
          scroll(event.deltaX, event.deltaX > 0 ? 128 : 64);
          continue;
        }
        if (event.kind === "text") {
          if (event.text) this.sendInput(`co,end,${event.text}`);
          continue;
        }
        const keysym = this.keysym(event.key);
        if (keysym === undefined) continue;
        if (event.type === "down") {
          this.inputKeys.add(keysym);
          this.sendInput(`kd,${keysym}`);
        } else {
          this.inputKeys.delete(keysym);
          this.sendInput(`ku,${keysym}`);
        }
      }
      return {};
    } catch (error) {
      await this.resetInput(clientId);
      throw error;
    } finally {
      this.inputBusy = false;
      clearTimeout(this.inputTimer);
      if (this.controlHeld) {
        this.inputTimer = setTimeout(() => void this.resetInput(clientId), 5000);
        this.inputTimer.unref();
      } else {
        this.inputOwner = undefined;
      }
    }
  }
  private packets: Buffer[] = [];
  private bytes = 0;
  private arrived=new WeakMap<Buffer,number>();
  private packetAt=0;
  private packetGapMs=0;
  private queueMs=0;
  timing(){const result={queueMs:this.queueMs,packetGapMs:this.packetGapMs};this.queueMs=0;this.packetGapMs=0;return result;}
  /** Live bitrate update in the pinned Selkies runtime, in kbps. */
  setBitrate(kbps: number) {
    if (!this.closed && Number.isInteger(kbps) && kbps >= 2000 && kbps <= 4000)
      this.socket?.send(`vb,${kbps}`);
  }
  private awaitingKeyframe = false;
  private captureFps = 30;
  private overloadAt = 0;
  private lastRateChange = 0;
  private overloadCount = 0;
  private keyframeRequestedAt = 0;
  private keyframeRetry?: ReturnType<typeof setTimeout>;
  private error?: Error;
  private closed = false;
  private wake?: () => void;
  private lastRead = Date.now();
  private timer?: ReturnType<typeof setInterval>;
  private stopping?: Promise<void>;
  static async start(root: string, env: NodeJS.ProcessEnv) {
    const runtime = join(
      root,
      "selkies-runtime/opt/selkies/lib/python3.13/site-packages",
    );
    if (
      process.platform !== "linux" ||
      !env.DISPLAY ||
      !existsSync(join(runtime, "selkies"))
    )
      throw Error(
        "Video prototype dependencies are unavailable on this session host.",
      );
    const stream = new SelkiesStream();
    try {
      const listener = createServer();
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      stream.child = spawnWatched(
        "python3",
        [
          "-m",
          "selkies",
          "--addr",
          "127.0.0.1",
          "--port",
          String(port),
          "--enable-basic-auth",
          "false",
          "--enable-https",
          "false",
          "--audio-enabled",
          "false",
          "--microphone-enabled",
          "false",
          "--webcam-enabled",
          "false",
          "--gamepad-enabled",
          "false",
          "--enable-clipboard",
          "false",
          "--file-transfers",
          "disabled",
          "--command-enabled",
          "false",
          "--enable-resize",
          "false",
          "--encoder",
          "h264enc",
          "--framerate",
          "30",
          "--video-bitrate",
          "4000",
          "--rate-control-mode",
          "cbr",
          "--video-streaming-mode",
          "false",
        ],
        {
          env: { ...env, PYTHONPATH: runtime },
          stderr: "ignore",
        },
      );
      stream.child.once("error", () =>
        stream.fail("Video encoder could not start."),
      );
      stream.child.once("exit", () => {
        if (!stream.closed) stream.fail("Video encoder stopped.");
      });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (stream.error) throw stream.error;
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/websockets`, {
          maxPayload: 4 * 1024 * 1024,
          handshakeTimeout: 500,
        });
        const connected = await new Promise<boolean>((resolve) => {
          socket.once("open", () => resolve(true));
          socket.once("error", () => resolve(false));
        });
        if (!connected) {
          socket.terminate();
          await sleep(100);
          continue;
        }
        stream.socket = socket;
        socket.on("error", () =>
          stream.fail("Video encoder connection failed."),
        );
        socket.on("close", () => {
          if (!stream.closed) stream.fail("Video encoder disconnected.");
        });
        socket.on("message", (data, binary) => {
          if (!binary || stream.closed) return;
          const packet = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          stream.enqueue(packet);
        });
        socket.send(
          "SETTINGS," +
            JSON.stringify({
              displayId: "primary",
              manual_resolution: true,
              manual_width: 1280,
              manual_height: 800,
              encoder: "h264enc",
              framerate: 30,
              video_bitrate: 4000,
              video_streaming_mode: false,
              video_fullcolor: false,
              useCssScaling: true,
              scaling_dpi: 96,
            }),
        );
        socket.send("START_VIDEO");
        stream.timer = setInterval(() => {
          if (Date.now() - stream.lastRead > 10000) void stream.stop();
        }, 2000);
        stream.timer.unref();
        return stream;
      }
      throw Error("Video encoder startup timed out.");
    } catch (error) {
      await stream.stop();
      throw error;
    }
  }
  private requestKeyframe() {
    if (this.closed || !this.awaitingKeyframe) return;
    clearTimeout(this.keyframeRetry);
    // The encoder throttles requests to 250 ms. Schedule the remainder even
    // after a previous recovery completed, rather than waiting for more frames.
    const remaining = Math.max(0, 300 - (Date.now() - this.keyframeRequestedAt));
    if (!remaining) {
      this.keyframeRequestedAt = Date.now();
      this.socket?.send("REQUEST_KEYFRAME");
    }
    this.keyframeRetry = setTimeout(() => this.requestKeyframe(), remaining || 300);
    this.keyframeRetry.unref();
  }
  private noteOverload() {
    const now = Date.now();
    this.overloadCount = now - this.overloadAt < 5000 ? this.overloadCount + 1 : 1;
    this.overloadAt = now;
    if (this.overloadCount < 2 || now - this.lastRateChange < 5000 || this.captureFps <= 15) return;
    this.captureFps = this.captureFps === 30 ? 24 : this.captureFps === 24 ? 20 : 15;
    this.overloadCount = 0;
    this.lastRateChange = now;
    // Pinned Selkies live-update opcode; does not recreate Chrome or its encoder.
    this.socket?.send(`_arg_fps,${this.captureFps}`);
  }
  private enqueue(packet: Buffer) {
    // The pinned full-frame H.264 protocol has a ten-byte header.
    if (packet.length < 11 || packet[0] !== 4) return;
    // Never replay a second of stale scrolling. Delta frames depend on
    // earlier frames, so recover at a fresh keyframe after dropping backlog.
    if (this.packets.length >= 8 || this.bytes + packet.length > 1024 * 1024) {
      this.noteOverload();
      for (const stale of this.packets)
        this.socket?.send(`CLIENT_FRAME_ACK ${stale.readUInt16BE(2)} 0`);
      this.packets = [];
      this.bytes = 0;
      this.awaitingKeyframe = true;
      this.requestKeyframe();
    }
    if (this.awaitingKeyframe) {
      if (packet[1] !== 1) {
        this.socket?.send(`CLIENT_FRAME_ACK ${packet.readUInt16BE(2)} 0`);
        this.requestKeyframe();
        return;
      }
      this.awaitingKeyframe = false;
      clearTimeout(this.keyframeRetry);
    }
    if (packet.length > 4 * 1024 * 1024) {
      this.fail("Video frame exceeds budget.");
      return;
    }
    const now=performance.now();if(this.packetAt)this.packetGapMs=Math.max(this.packetGapMs,now-this.packetAt);this.packetAt=now;this.arrived.set(packet,now);
    this.packets.push(packet);
    this.bytes += packet.length;
    this.wake?.();
  }
  private fail(message: string) {
    this.error = new Error(message);
    void this.stop();
  }
  async read(): Promise<string[]> {
    return (await this.readPackets()).map((packet) =>
      packet.toString("base64"),
    );
  }
  async readPackets(limit = 8): Promise<Buffer[]> {
    this.lastRead = Date.now();
    if (this.error) throw this.error;
    if (this.closed) throw Error("Video stream closed.");
    if (!this.packets.length)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    this.wake = undefined;
    if (this.error) throw this.error;
    const packets = this.packets.splice(0, Math.max(1, Math.min(8, limit)));
    for (const packet of packets) {
      this.queueMs=Math.max(this.queueMs,performance.now()-(this.arrived.get(packet)??performance.now()));
      this.bytes -= packet.length;
      this.socket?.send(`CLIENT_FRAME_ACK ${packet.readUInt16BE(2)} 0`);
    }
    return packets;
  }
  stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      await this.resetInput();
      this.closed = true;
      this.onStop?.();
      clearInterval(this.timer);
      clearTimeout(this.keyframeRetry);
      clearTimeout(this.inputTimer);
      this.wake?.();
      this.packets = [];
      this.bytes = 0;
      this.socket?.terminate();
      const child = this.child;
      if (child && child.exitCode === null && !child.signalCode) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          sleep(1000),
        ]);
        if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      }
    })());
  }
}
