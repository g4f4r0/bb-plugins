import { controlRelay } from "./src/control-relay";
import type {z} from "zod";
import {directBatch} from "./src/direct-input";
import { videoRelay } from "./src/video-relay";
import { SelkiesStream } from "./src/selkies";
import { StreamDemands } from "./src/adaptive-stream";
import { DirectInput } from "./src/direct-input";
import { localServers } from "./src/local-servers";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CredentialBinding } from "./src/credentials";
import { setTimeout as sleep } from "node:timers/promises";
import {
  hostContract,
  VERSION,
  CREDENTIAL_TIMEOUT_MS,
  type Job,
  type Artifact,
  type Operation,
} from "./src/contracts";
import {
  diagnostics,
  installManaged,
  launchManaged,
  managedEnv,
  type ManagedBrowser,
} from "./src/managed";
import { downloadFromClick } from "./src/native-download";
import { safeUrl } from "./src/policy";
import { pruneJobHistory } from "./src/job-history";
import { BrowserDriver } from "./src/driver";
import { Recorder } from "./src/recorder";
import { Cdp } from "./src/cdp";
import { drawStrokes } from "./src/gesture";
import { pngToPdf } from "./src/pdf";
import { capturePng } from "./src/capture";
import { downloadExpression } from "./src/download";
import { actOnElement } from "./src/element";
import { runSequence } from "./src/sequence";
import { observeExpression, deepQuerySource } from "./src/observe";
import { Bridge } from "./src/bridge";
import { validateCommand, redact } from "./src/policy";
import {
  openDevToolsLayout,
  restorePageWindow,
  type DevToolsLayoutState,
} from "./src/devtools-layout";
import { assertBrowserMemory } from "./src/memory-budget";

type LocalSession = {
  credential?: {
    token: string;
    binding?: CredentialBinding;
    timer?: ReturnType<typeof setTimeout>;
    expiresAt: number;
  };
  id: string;
  managed?: ManagedBrowser;
  video?: {clientId:string;stream:Promise<SelkiesStream>};
  videoMode?: boolean;
  videoInput?: SelkiesStream;
  devtoolsOpen?: boolean;
  devtoolsLayout?: DevToolsLayoutState;
  browserEvents?: () => void;
  dialog?: {
    type: "alert" | "confirm" | "prompt" | "beforeunload";
    message: string;
    defaultPrompt?: string;
  };
  viewport?: { width: number; height: number; mobile: boolean };
  mode?: "managed" | "native";
  framing?: boolean;
  streamDemands?: StreamDemands;
  direct?: DirectInput;
  controlRelays?: Set<()=>void>;
  frameInfo?: {url:string;loading:boolean;at:number};
  castTimer?: ReturnType<typeof setTimeout>;
  status: "connecting" | "ready" | "error" | "released";
  error?: string;
  recording: boolean;
  recordingPath?: string;
  artifactRoot: string;
  targetId?: string;
  endpoint: string;
  expiresAt: number;
  cdp?: Cdp;
  bridge?: Bridge;
  root: string;
  driver?: BrowserDriver;
  idleTimeoutMs: number;
  recorder?: Recorder;
  retain: ExperimentalHostWorkerLease;
  busy?: string;
  closing?: Promise<void>;
  pointerAction?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
type Task = { view: Job; controller: AbortController; promise: Promise<void> };
const sessions = new Map<string, LocalSession>(),
  jobs = new Map<string, Task>();
async function waitForDocumentReady(cdp: Cdp, signal: AbortSignal) {
  const deadline = Date.now() + 10000;
  for (;;) {
    signal.throwIfAborted();
    try {
      const state = await cdp.evaluate("document.readyState", 2000);
      if (state === "interactive" || state === "complete") return;
    } catch {}
    if (Date.now() >= deadline) throw new Error("Initial page load timed out.");
    await sleep(25, undefined, { signal });
  }
}
function scheduleExpiry(s: LocalSession) {
  clearTimeout(s.timer);
  s.timer = setTimeout(
    () => {
      if (s.mode === "managed" && (s.busy || s.credential || s.recorder)) {
        touchSession(s);
        return;
      }
      void release(s);
    },
    Math.max(1, s.expiresAt - Date.now()),
  );
  s.timer.unref();
}
function touchSession(s: LocalSession) {
  if (s.mode !== "managed" || s.status === "released" || s.closing) return;
  s.expiresAt = Date.now() + s.idleTimeoutMs;
  scheduleExpiry(s);
}
async function runDirect({id,clientId,events}:z.infer<typeof directBatch>){
      const began=performance.now();
      const s=session(id);
      if(s.status!=='ready'||!s.cdp||s.closing||s.expiresAt<=Date.now())throw Error('Browser is not ready.');
      if(s.credential)throw Error('Browser is waiting for private credential input.');
      if(s.busy)throw Error('Browser is busy with an agent action.');
      let result: { selection?: string; cursor?: string };
      if (s.videoInput && !s.videoInput.isClosed) {
        result = await s.videoInput.runInput(clientId, events);
      } else {
        s.direct??=new DirectInput(s.cdp,()=>!!s.dialog);
        result=await s.direct.run(clientId,events);
      }
      if(events.some(e=>e.kind!=='reset'&&(e.kind!=='pointer'||e.type!=='move'||e.buttons)))touchSession(s);
      return {...result,hostMs:performance.now()-began};
}
function publicSession(s: LocalSession) {
  return {
    id: s.id,
    status: s.status,
    error: s.error,
    recording: s.recording,
    artifactRoot: s.artifactRoot,
    targetId: s.targetId,
    busy: s.busy,
    expiresAt: s.expiresAt,
    viewport: s.viewport,
    devtoolsOpen: !!s.devtoolsOpen,
    dialog: s.dialog,
  };
}

async function applyViewport(
  cdp: Cdp,
  viewport: { width: number; height: number; mobile: boolean },
) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
    screenOrientation: {
      type: viewport.width > viewport.height ? "landscapePrimary" : "portraitPrimary",
      angle: viewport.width > viewport.height ? 90 : 0,
    },
  });
}

async function restoreDevToolsSession(s: LocalSession) {
  const layout = s.devtoolsLayout;
  s.devtoolsOpen = false;
  s.devtoolsLayout = undefined;
  if (!s.cdp || !s.targetId) return;
  await restorePageWindow(s.cdp, s.targetId, layout?.pageWindowId).catch(() => {});
  if (s.viewport) await applyViewport(s.cdp, s.viewport).catch(() => {});
  // Prime a fresh responsive frame while the video surface is still closing.
  // Static pages may not produce compositor damage after the JPEG viewer takes
  // over, which otherwise leaves the correctly sized transition skeleton up.
  await s.cdp.startLiveCast().catch(() => {});
}
function session(id: string) {
  const s = sessions.get(id);
  if (!s || s.closing)
    throw new Error(
      "Session is unavailable. Start a new connection to the existing tab.",
    );
  return s;
}
function task(id: string) {
  const j = jobs.get(id);
  if (!j)
    throw new Error("Job not found (the browser worker may have restarted).");
  return j;
}
function view(t: Task): Job {
  return {
    ...t.view,
    durationMs: (t.view.endedAt ?? Date.now()) - t.view.startedAt,
  };
}
async function releaseViewerInput(s: LocalSession, clientId?: string) {
  if (!clientId) return;
  const deadline = Date.now() + 750;
  while (
    Date.now() < deadline &&
    (s.direct?.busy || s.videoInput?.controlBusy)
  )
    await sleep(25);
  // The server already verified that clientId owns the human-control lease.
  // Clear every host-side input owner, including a stale DevTools trigger ID,
  // before starting this viewer's toolbar or dialog job.
  await Promise.all([
    s.direct?.reset(),
    s.videoInput?.resetInput(),
  ]);
}
function startJob(
  kind: string,
  ctx: ExperimentalHostRpcContext,
  fn: (signal: AbortSignal, j: Job) => Promise<void>,
  s?: LocalSession,
  timeoutMs = 120000,
): Job {
  if (s?.credential)
    throw new Error("Browser is waiting for private credential input.");
  if (s?.direct?.busy || s?.direct?.held || s?.videoInput?.controlBusy || s?.videoInput?.controlHeld)
    throw new Error("Browser is being controlled by a viewer.");
  if (s?.busy)
    throw new Error(
      `Session is busy with job ${s.busy}. Poll it or cancel it first.`,
    );
  pruneJobHistory(jobs);
  const id = randomUUID(),
    controller = new AbortController(),
    retain = ctx.experimental_retainWorker();
  const j: Job = {
    id,
    sessionId: s?.id,
    kind,
    status: "running",
    startedAt: Date.now(),
    durationMs: 0,
    artifacts: [],
  };
  if (s) { s.busy = id; touchSession(s); }
  const timeout = setTimeout(
    () => controller.abort(new Error("Job timed out")),
    timeoutMs,
  );
  const onAbort = () => {
    if (s && kind !== "gesture" && !s.pointerAction) {
      s.bridge?.close();
      s.cdp?.close();
      void s.managed?.close().catch(() => {});
      s.status = "error";
      s.error =
        "Action cancelled. Reconnect to the existing tab before continuing.";
    }
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const abort = () => controller.abort();
  ctx.lifecycle.signal.addEventListener("abort", abort, { once: true });
  const t: Task = { view: j, controller, promise: Promise.resolve() };
  jobs.set(id, t);
  t.promise = (async () => {
    try {
      await fn(controller.signal, j);
      controller.signal.throwIfAborted();
      j.status = "succeeded";
    } catch (e) {
      j.status = controller.signal.aborted ? "cancelled" : "failed";
      j.error = redact(e instanceof Error ? e.message : String(e), s?.endpoint);
    } finally {
      if (controller.signal.aborted && s && kind !== "gesture") {
        s.bridge?.close();
        s.cdp?.close();
        s.status = "error";
        s.error =
          "Action cancelled. Reconnect to the existing tab before continuing.";
      }
      if (controller.signal.aborted && s?.managed && kind !== "gesture") {
        await s.managed.close();
        s.managed = undefined;
      }
      controller.signal.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      ctx.lifecycle.signal.removeEventListener("abort", abort);
      j.endedAt = Date.now();
      j.durationMs = j.endedAt - j.startedAt;
      if (s) { s.busy = undefined; touchSession(s); }
      await retain.dispose();
      if (
        s &&
        !s.closing &&
        ((kind === "connect" && j.status !== "succeeded") ||
          (controller.signal.aborted && kind !== "gesture"))
      )
        await release(s);
      pruneJobHistory(jobs, j.id);
    }
  })();
  return view(t);
}
async function command(
  s: LocalSession,
  args: string[],
  signal?: AbortSignal,
  stdin?: string,
  limit?: number,
) {
  if (!s.driver) throw new Error("Browser control is not connected.");
  if (args[0] === "batch" && stdin) {
    const results = [];
    for (const step of JSON.parse(stdin) as string[][]) {
      try {
        const result = JSON.parse(await command(s, step, signal));
        results.push({
          command: step,
          success: true,
          result: result.data,
          error: null,
        });
      } catch (e) {
        results.push({
          command: step,
          success: false,
          result: null,
          error: redact(String(e), s.endpoint),
        });
        break;
      }
    }
    return JSON.stringify(results);
  }
  const output = await s.driver.execute(args, signal);
  if (output.length > (limit ?? 2 * 1024 * 1024))
    throw new Error("Output exceeds limit. Scope the query before retrying.");
  return redact(output, s.endpoint);
}

async function save(
  s: LocalSession,
  name: string,
  data: Buffer,
  mime: string,
): Promise<Artifact> {
  const path = join(s.artifactRoot, name);
  await fs.writeFile(path, data, { mode: 0o600 });
  return { id: name, name, path, mime, bytes: data.length };
}
async function files(
  s: Pick<LocalSession, "artifactRoot">,
): Promise<Artifact[]> {
  const names = await fs.readdir(s.artifactRoot);
  const result: Artifact[] = [];
  for (const name of names) {
    const path = join(s.artifactRoot, name),
      stat = await fs.lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink())
      result.push({
        id: name,
        name,
        path,
        bytes: stat.size,
        mime: name.endsWith(".png")
          ? "image/png"
          : name.endsWith(".webm")
            ? "video/webm"
            : name.endsWith(".pdf")
              ? "application/pdf"
              : "application/octet-stream",
      });
  }
  return result.slice(-200);
}
async function perform(
  s: LocalSession,
  op: Operation,
  signal: AbortSignal,
  j: Job,
) {
  if (s.status !== "ready" || Date.now() >= s.expiresAt)
    throw new Error(
      "Session is not ready or its control lease expired. Reconnect to the existing tab.",
    );
  switch (op.kind) {
    case "sequence": {
      await runSequence(op.steps, signal, j, (step, child) =>
        perform(s, step, signal, child),
      );
      break;
    }
    case "element": {
      s.pointerAction = op.action !== "fill";
      try {
        j.output = await s.driver!.element(
          op.action,
          op.selector,
          op.value,
          op.waitMs,
          signal,
        );
      } finally {
        s.pointerAction = false;
      }
      break;
    }
    case "observe": {
      const raw = JSON.parse(
        await command(
          s,
          ["batch", "--bail"],
          signal,
          JSON.stringify([
            ["snapshot", "-i"],
            ["eval", observeExpression],
          ]),
        ),
      );
      const failed = raw.find((r: any) => !r.success);
      if (failed) throw new Error(failed.error);
      j.output = JSON.stringify({
        accessibility: raw[0].result,
        dom: raw[1].result?.result,
      });
      if (op.screenshot) {
        const data = await capturePng(s.cdp!, false, {
          recording: s.recording,
        });
        j.artifacts = [
          await save(
            s,
            `${Date.now()}-observation.png`,
            Buffer.from(data, "base64"),
            "image/png",
          ),
        ];
      }
      break;
    }
    case "command":
      validateCommand(op.args);
      j.output = await command(s, op.args, signal);
      break;
    case "batch":
      op.commands.forEach(validateCommand);
      j.output = await command(
        s,
        ["batch", "--bail"],
        signal,
        JSON.stringify(op.commands),
      );
      {
        const a = JSON.parse(j.output);
        if (Array.isArray(a) && a.some((r) => r.success === false))
          throw new Error(j.output);
      }
      break;
    case "gesture":
      s.pointerAction = true;
      try {
        j.output = await drawStrokes(s.cdp!, op, signal);
      } finally {
        s.pointerAction = false;
      }
      break;
    case "screenshot": {
      const data = await capturePng(s.cdp!, op.fullPage, {
        recording: s.recording,
      });
      j.artifacts = [
        await save(
          s,
          `${Date.now()}-screenshot.png`,
          Buffer.from(data, "base64"),
          "image/png",
        ),
      ];
      j.output = op.fullPage
        ? "Full page PNG saved."
        : "Visible page PNG saved.";
      break;
    }
    case "canvas": {
      const encoded = await command(
        s,
        [
          "eval",
          `(()=>{${deepQuerySource}const matches=deepQuery(${JSON.stringify(op.selector)});if(matches.length!==1)throw new Error('Selector must identify one canvas; found '+matches.length);const c=matches[0];if(!(c instanceof HTMLCanvasElement))throw new Error('Canvas not found');return c.toDataURL('image/png')})()`,
        ],
        signal,
        undefined,
        32 * 1024 * 1024,
      );
      const result = JSON.parse(encoded).data?.result;
      if (
        typeof result !== "string" ||
        !result.startsWith("data:image/png;base64,")
      )
        throw new Error("Canvas did not return a PNG");
      j.artifacts = [
        await save(
          s,
          `${Date.now()}-canvas.png`,
          Buffer.from(result.split(",")[1], "base64"),
          "image/png",
        ),
      ];
      j.output = "Original canvas PNG exported.";
      break;
    }
    case "record":
      if (op.action === "start") {
        if (s.recording) throw new Error("Recording is already active.");
        s.recordingPath = join(s.artifactRoot, `${Date.now()}-recording.webm`);
        s.recording = true;
        try {
          await s.cdp!.configureLiveCast(0);
          s.recorder = await Recorder.start(
            s.cdp!, s.recordingPath, op.fps, managedEnv(s.root),
          );
        } catch (error) {
          s.recording = false;
          throw error;
        }
        j.output = "Recording started.";
      } else {
        if (!s.recording) throw new Error("No recording is active.");
        await s.recorder?.stop();
        s.recorder = undefined;
        j.output = "Recording saved.";
        s.recording = false;
        j.artifacts = (await files(s)).filter(
          (a) => a.path === s.recordingPath,
        );
      }
      break;
    case "downloadClick": {
      if (s.mode !== "managed")
        throw new Error(
          "Browser download buttons require managed mode. Use download for native-tab links.",
        );
      const dir = join(s.root, "downloads", s.id);
      try {
        const path = await downloadFromClick(
          s.cdp!,
          dir,
          async () => {
            s.pointerAction = true;
            try {
              await actOnElement(
                s.cdp!,
                {
                  kind: "element",
                  action: "click",
                  selector: op.selector,
                  waitMs: 3000,
                },
                signal,
              );
            } finally {
              s.pointerAction = false;
            }
          },
          signal,
        );
        const stat = await fs.stat(path);
        if (stat.size > 128 * 1024 * 1024)
          throw new Error("Download exceeds 128 MB");
        const name = `${Date.now()}-${op.name}`,
          destination = join(s.artifactRoot, name);
        await fs.rename(path, destination);
        await fs.chmod(destination, 0o600);
        j.artifacts = (await files(s)).filter((a) => a.name === name);
        j.output = "Browser download completed.";
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
      break;
    }
    case "download": {
      let href: string | undefined;
      if (/^@/.test(op.selector)) {
        const attr = JSON.parse(
          await command(s, ["get", "attr", op.selector, "href"], signal),
        );
        href = attr.data?.value ?? attr.data?.attribute;
        if (typeof href !== "string" || !href)
          throw new Error("Direct downloads require a link with href.");
        // Upstream refs can belong to an iframe while eval always uses the top page.
        if (!/^(https?:|blob:|data:)/i.test(href))
          throw new Error(
            "For relative download links, use a CSS selector in the top page so its base URL is resolved accurately.",
          );
      }
      const data = await s.cdp!.evaluate(
        downloadExpression(op.selector, href),
        35000,
      );
      if (
        typeof data !== "string" ||
        !data.startsWith("data:") ||
        !data.includes(";base64,")
      )
        throw new Error("Download did not return file data");
      const mime = data.slice(5, data.indexOf(";base64,"));
      j.artifacts = [
        await save(
          s,
          `${Date.now()}-${op.name}`,
          Buffer.from(data.slice(data.indexOf(",") + 1), "base64"),
          mime || "application/octet-stream",
        ),
      ];
      j.output =
        "Link content saved through the authenticated page. Use downloadClick for managed browser download buttons.";
      break;
    }
    case "pdf": {
      if (s.mode === "managed") {
        const { data } = await s.cdp!.send("Page.printToPDF", {
          printBackground: true,
          preferCSSPageSize: true,
        });
        j.artifacts = [
          await save(
            s,
            `${Date.now()}-page.pdf`,
            Buffer.from(data, "base64"),
            "application/pdf",
          ),
        ];
        j.output = "Browser PDF exported with selectable text.";
        break;
      }
      const data = await capturePng(s.cdp!, true, { recording: s.recording });
      const pdf = await pngToPdf(Buffer.from(data, "base64"));
      j.artifacts = [
        await save(
          s,
          `${Date.now()}-page.pdf`,
          Buffer.from(pdf),
          "application/pdf",
        ),
      ];
      j.output =
        "Page capture saved as an image-based PDF. Text is not selectable.";
      break;
    }
  }
}
async function finishCredential(
  s: LocalSession,
  pending: NonNullable<LocalSession["credential"]>,
) {
  clearTimeout(pending.timer);
  await pending.binding?.dispose();
  if (s.credential === pending) delete s.credential;
}
function release(s: LocalSession): Promise<void> {
  if (s.closing) return s.closing;
  if (s.status === "released") return Promise.resolve();
  return (s.closing = closeSession(s));
}
async function closeSession(s: LocalSession) {
  clearTimeout(s.timer);
  clearTimeout(s.castTimer);
  s.browserEvents?.();
  s.browserEvents = undefined;
  if(s.video)await s.video.stream.then(stream=>stream.stop()).catch(()=>{});
  s.video=undefined;
  s.videoInput=undefined;
  for(const stop of s.controlRelays??[])stop();
  s.controlRelays?.clear();
  await s.direct?.reset();
  if (s.credential) await finishCredential(s, s.credential);
  if (s.busy) {
    const t = task(s.busy);
    t.controller.abort();
    await Promise.race([t.promise, sleep(1800)]);
  }
  if (s.recording) {
    await s.recorder?.stop().catch(() => {});
    s.recording = false;
  }
  s.status = "released";
  await s.cdp?.stopLiveCast().catch(() => {});
  if (s.managed) {
    await s.cdp?.send("Browser.close", {}, false, 1500).catch(() => {});
    // Give Chrome a brief graceful-exit window to flush persistent profile
    // data before the managed-process fallback sends a termination signal.
    if (s.managed.process.exitCode === null && !s.managed.process.signalCode)
      await Promise.race([
        new Promise<void>((resolve) => s.managed!.process.once("exit", () => resolve())),
        sleep(1500),
      ]);
  }
  s.cdp?.close();
  s.cdp = undefined;
  await s.driver?.close().catch(() => {});
  s.driver = undefined;
  s.bridge?.close();
  await s.managed?.close();
  s.managed = undefined;
  s.status = "released";
  s.endpoint = "";
  await s.retain.dispose();
  sessions.delete(s.id);
  s.bridge = undefined;
}
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    credentialPrepare: async (input, ctx) => {
      const s = session(input.id);
      if (
        s.status !== "ready" ||
        !s.cdp ||
        (s.mode === "native" &&
          s.expiresAt < Date.now() + CREDENTIAL_TIMEOUT_MS + 30000) ||
        s.busy ||
        s.framing ||
        s.direct?.busy || s.direct?.held ||
        s.recording ||
        s.credential
      )
        throw new Error(
          "Use an idle connected browser with recording stopped and at least six minutes of control remaining. Reconnect an expiring native session first.",
        );
      const pending: NonNullable<LocalSession["credential"]> = {
        token: randomUUID(),
        expiresAt: Date.now() + CREDENTIAL_TIMEOUT_MS,
      };
      s.credential = pending;
      try {
        ctx.signal.throwIfAborted();
        pending.binding = await CredentialBinding.prepare(s.cdp!, input);
        ctx.signal.throwIfAborted();
        if (s.credential !== pending || s.closing)
          throw new Error("Session closed");
        pending.timer = setTimeout(() => {
          void finishCredential(s, pending);
        }, CREDENTIAL_TIMEOUT_MS);
        return { token: pending.token, origin: pending.binding.origin };
      } catch {
        await finishCredential(s, pending);
        throw new Error(
          "Login fields are unavailable or unsafe. Inspect the page and request again.",
        );
      }
    },
    credentialFill: async ({ id, token, values }, ctx) => {
      const s = session(id),
        pending = s.credential;
      if (
        !pending ||
        pending.token !== token ||
        !pending.binding ||
        pending.expiresAt <= Date.now()
      )
        throw new Error("Credential request expired. Request again.");
      pending.token = "";
      clearTimeout(pending.timer);
      const count = values.length;
      try {
        ctx.signal.throwIfAborted();
        await pending.binding.fill(values);
        await sleep(1200, undefined, { signal: ctx.signal });
        return { filled: true, count };
      } catch {
        throw new Error(
          "Could not complete credential delivery. Inspect the page and request again if needed.",
        );
      } finally {
        values.fill("");
        await finishCredential(s, pending);
      }
    },
    credentialCancel: async ({ id, token }) => {
      const s = sessions.get(id);
      if (s?.credential?.token === token)
        await finishCredential(s, s.credential);
      return { cancelled: true };
    },
    "local-servers": async () => localServers(),
    videoStart: async ({id,clientId,binary})=>{
      const s=session(id);
      const deadline=Date.now()+10000;
      while(s.status==="connecting"&&Date.now()<deadline)await sleep(50);
      if(s.status!=="ready"||!s.managed?.displayEnv)throw Error("This session has no isolated video display.");
      if (s.video) {
        const previous = s.video;
        const restartDeadline = Date.now() + 1500;
        while (s.video === previous && Date.now() < restartDeadline) await sleep(25);
      }
      if(s.video)throw Error("The video prototype supports one viewer at a time.");
      const env=s.managed.displayEnv;
      const stream=(async()=>{if(!s.recording)await s.cdp?.stopLiveCast();return SelkiesStream.start(s.root,env);})();
      s.video={clientId,stream};
      let encoder: SelkiesStream | undefined;
      try {
        const ready=await stream;
        encoder=ready;
        s.videoInput=ready;
        const relay=binary?await videoRelay(ready,async()=>({...await s.cdp!.evaluate("({url:location.href,loading:document.readyState==='loading'})"),hostVideo:ready.timing()})):undefined;
        return {ok:true,...(relay?{relay}:{})};
      } catch(e) {
        await encoder?.stop().catch(()=>{});
        if(s.video?.clientId===clientId)s.video=undefined;
        if(s.videoInput===encoder)s.videoInput=undefined;
        throw e;
      }
    },
    videoRead: async ({id,clientId})=>{const s=session(id);if(s.video?.clientId!==clientId)throw Error("Video lease is unavailable.");const packets=await (await s.video.stream).read();if(!s.frameInfo||Date.now()-s.frameInfo.at>500){const info=await s.cdp!.evaluate("({url:location.href,loading:document.readyState==='loading'})");s.frameInfo={...info,at:Date.now()};}return {packets,url:s.frameInfo!.url,loading:s.frameInfo!.loading};},
    videoStop: async ({id,clientId})=>{const s=sessions.get(id);if(s?.video?.clientId===clientId){const lease=s.video;const encoder=await lease.stream.catch(()=>undefined);await encoder?.resetInput(clientId);await encoder?.stop().catch(()=>{});if(s.video===lease)s.video=undefined;if(s.videoInput===encoder)s.videoInput=undefined;}return {ok:true};},
    probe: async (_, ctx) => {
      const root = ctx.experimental_paths.dataDir,
        info = await diagnostics(root);
      if (info.browserRunnable)
        try {
          const browser = await launchManaged(
            root,
            `ab-check-${randomUUID()}`,
            ctx.signal,
          );
          await browser.close();
          // Chrome helpers can finish profile writes just after the main process exits.
          // Cleanup failure must not turn a verified launch into a browser failure.
          await fs
            .rm(browser.profile, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 200,
            })
            .catch(() => {});
        } catch (e) {
          info.browserRunnable = false;
          info.launchError = redact(String(e));
        }
      return { ...info, version: VERSION, installed: info.runtime };
    },
    setup: (input, ctx) =>
      startJob(
        "setup",
        ctx,
        async (signal, j) => {
          if (
            [...sessions.values()].some(
              (s) =>
                s.mode === "managed" &&
                (s.managed || s.status === "connecting"),
            )
          )
            throw new Error(
              "Close managed browser sessions before updating their dependencies.",
            );
          await installManaged(
            ctx.experimental_paths.dataDir,
            input?.dependencies ?? true,
            signal,
          );
          const info = await diagnostics(ctx.experimental_paths.dataDir);
          if (!info.browserRunnable)
            throw new Error(
              info.launchError ??
                "Fortress installation did not produce a runnable executable",
            );
          if (info.display === "missing")
            throw new Error(
              "Headed display is not ready (Xvfb, xkbcomp, and XKB keymap data). Re-run Install dependencies.",
            );
          j.output = JSON.stringify(info);
        },
        undefined,
        600000,
      ),
    controlStart: async ({id,clientId})=>{
      const s=session(id);s.controlRelays??=new Set();
      if(s.controlRelays.size>=16)throw Error('Too many browser controllers');
      let relay:Awaited<ReturnType<typeof controlRelay>>|undefined;
      const stop=()=>relay?.stop();s.controlRelays.add(stop);
      try{
        relay=await controlRelay(events=>runDirect({id,clientId,events}),async()=>{await s.direct?.reset(clientId);},()=>s.controlRelays?.delete(stop));
        if(s.closing||s.status==='released'){relay.stop();throw Error('Browser session closed');}
        return {port:relay.port,token:relay.token};
      }catch(e){s.controlRelays.delete(stop);throw e;}
    },
    direct: runDirect,
    frame: async ({ id, after = 0, stream }) => {
      const s = session(id);
      if (s.status !== "ready" || !s.cdp || s.expiresAt <= Date.now())
        throw new Error("Browser is not ready");
      s.streamDemands ??= new StreamDemands();
      const tier = s.streamDemands.update(stream);
      await s.cdp.configureLiveCast(s.recording ? 0 : tier);
      await s.cdp.startLiveCast();
      const live = await s.cdp.nextLiveFrame(after);
      clearTimeout(s.castTimer);
      s.castTimer=setTimeout(()=>{void s.cdp?.stopLiveCast();},12000);s.castTimer.unref();
      if(!s.frameInfo||Date.now()-s.frameInfo.at>100){
        const [url,loading]=await Promise.all([s.cdp.evaluate('location.href'),s.cdp.evaluate('document.readyState !== "complete"')]);
        s.frameInfo={url,loading:loading===true,at:Date.now()};
      }
      return { ...live, url:s.frameInfo.url, loading:s.frameInfo.loading, streamTier:s.recording ? 0 : tier };
    },
    input: async ({ id, clientId, input }, ctx) => {
      const s = session(id);
      if (s.status !== "ready" || !s.cdp || s.expiresAt <= Date.now())
        throw new Error("Browser is not ready");
      await releaseViewerInput(s, clientId);
      const j = startJob(
        "viewer",
        ctx,
        async (signal, j) => {
          switch (input.kind) {
            case "click":
              s.pointerAction = true;
              try {
                await drawStrokes(
                  s.cdp!,
                  {
                    kind: "gesture",
                    strokes: [[{ x: input.x, y: input.y }]],
                    intervalMs: 0,
                  },
                  signal,
                );
              } finally {
                s.pointerAction = false;
              }
              break;
            case "scroll":
              const metrics = await s.cdp!.send("Page.getLayoutMetrics");
              const viewport =
                metrics.cssVisualViewport ?? metrics.visualViewport;
              await s.cdp!.send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: Math.floor(viewport.clientWidth / 2),
                y: Math.floor(viewport.clientHeight / 2),
                deltaX: 0,
                deltaY: input.deltaY,
              });
              break;
            case "text":
              await s.cdp!.send("Input.insertText", { text: input.text });
              break;
            case "key":
              await command(s, ["press", input.key], signal);
              break;
            case "viewport":
              if (s.mode !== "managed")
                throw new Error("Responsive mode is available only in an isolated Browse session.");
              await applyViewport(s.cdp!, input);
              s.viewport = input;
              await s.cdp!.refreshLiveCast();
              break;
            case "dialog":
              if (!s.dialog)
                throw new Error("The browser dialog is no longer open.");
              await s.cdp!.send("Page.handleJavaScriptDialog", {
                accept: input.accept,
                ...(input.promptText !== undefined
                  ? { promptText: input.promptText }
                  : {}),
              });
              s.dialog = undefined;
              break;
            case "maintenance":
              if (input.action === "hard-reload") {
                await s.cdp!.send("Page.reload", { ignoreCache: true });
              } else if (input.action === "open-devtools") {
                if (s.mode !== "managed" || !s.videoMode)
                  throw new Error("DevTools is available only in an isolated live Browse session.");
                const videoDeadline = Date.now() + 5000;
                while ((!s.videoInput || s.videoInput.isClosed) && Date.now() < videoDeadline)
                  await sleep(25, undefined, { signal });
                const videoInput = s.videoInput;
                if (!videoInput || videoInput.isClosed)
                  throw new Error("The live browser view could not reconnect for DevTools.");
                const trigger = () => videoInput.runInput(`devtools:${s.id}`, [
                  { kind: "keyboard", type: "down", key: "Control", code: "ControlLeft", modifiers: 2, repeat: false },
                  { kind: "keyboard", type: "down", key: "Shift", code: "ShiftLeft", modifiers: 10, repeat: false },
                  { kind: "keyboard", type: "down", key: "i", code: "KeyI", modifiers: 10, repeat: false },
                  { kind: "keyboard", type: "up", key: "i", code: "KeyI", modifiers: 10, repeat: false },
                  { kind: "keyboard", type: "up", key: "Shift", code: "ShiftLeft", modifiers: 2, repeat: false },
                  { kind: "keyboard", type: "up", key: "Control", code: "ControlLeft", modifiers: 0, repeat: false },
                ]).then(() => {});
                s.devtoolsLayout = await openDevToolsLayout(
                  s.cdp!,
                  s.targetId!,
                  trigger,
                  signal,
                );
                s.devtoolsOpen = true;
              } else {
                if (s.mode !== "managed") throw new Error("Clearing browser data is supported only in an isolated Browse profile.");
                await s.cdp!.send(input.action === "clear-cookies" ? "Network.clearBrowserCookies" : "Network.clearBrowserCache", {});
              }
              break;
            case "history":
              await command(s, [input.action], signal);
              break;
            case "navigate":
              await command(s, ["open", safeUrl(input.url)], signal);
              break;
          }
          j.output = "Viewer input completed.";
        },
        s,
        30000,
      );
      await Promise.race([task(j.id).promise, sleep(400)]);
      return view(task(j.id));
    },
    connect: async (input, ctx) => {
      if (sessions.has(input.id)) throw new Error("Session already exists");
      if (!/^ab-[a-z0-9-]+$/.test(input.id))
        throw new Error("Invalid session ID");
      const root = ctx.experimental_paths.dataDir;
      const artifactRoot = join(root, "artifacts", input.id);
      const s: LocalSession = {
        id: input.id,
        mode: input.mode,
        videoMode: input.video,
        status: "connecting",
        recording: false,
        artifactRoot,
        endpoint: input.endpoint,
        expiresAt: input.expiresAt,
        idleTimeoutMs: input.idleTimeoutMs,
        root,
        retain: ctx.experimental_retainWorker(),
      };
      sessions.set(s.id, s);
      scheduleExpiry(s);
      return startJob(
        "connect",
        ctx,
        async (signal, j) => {
          try {
            await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
            // Exclusive creation avoids truncating a config another start is reading.
            await fs
              .writeFile(join(root, "config.json"), "{}", {
                mode: 0o600,
                flag: "wx",
              })
              .catch((e) => {
                if (e.code !== "EEXIST") throw e;
              });

            const startupAt = Date.now();
            signal.throwIfAborted();
            const initialUrl = input.mode === "managed" ? safeUrl(input.url) : input.url;
            if (input.mode === "managed") {
              if (process.platform === "linux")
                await fs
                  .readFile("/proc/meminfo", "utf8")
                  .then(assertBrowserMemory)
                  .catch((error: NodeJS.ErrnoException) => {
                    if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
                  });
              s.managed = await launchManaged(
                root,
                input.profileId ?? input.id,
                signal,
                input.video,
                input.video ? initialUrl : "about:blank",
              );
              s.endpoint = s.managed.endpoint;
              s.managed.process.once("exit", () => {
                if (s.status === "ready" || s.status === "connecting") {
                  s.status = "error";
                  s.error =
                    "Browser process exited. Reconnect to reopen the profile.";
                }
              });
            } else {
              s.bridge = await Bridge.open(s.endpoint);
              s.bridge.onDisconnect = () => {
                if (s.status === "ready" || s.status === "connecting") {
                  s.status = "error";
                  s.error =
                    "Browser control disconnected or was taken over. The tab is preserved; reconnect explicitly.";
                }
              };
              s.endpoint = s.bridge.endpoint;
            }
            const chromeReadyAt = Date.now();
            s.cdp = await Cdp.connect(
              s.endpoint,
              input.mode === "managed" && !input.video,
              input.mode === "managed" && !!input.video,
              initialUrl,
            );
            s.targetId = s.cdp.targetId;
            s.cdp.onDisconnect = () => {
              if (s.status !== "released") {
                s.status = "error";
                s.error =
                  "Browser disconnected or its tab closed. Reconnect the session.";
              }
            };
            s.browserEvents = s.cdp.onEvent((method, params) => {
              if (method === "Page.javascriptDialogOpening")
                s.dialog = {
                  type: ["alert", "confirm", "prompt", "beforeunload"].includes(
                    params?.type,
                  )
                    ? params.type
                    : "alert",
                  message: String(params?.message ?? ""),
                  ...(params?.defaultPrompt
                    ? { defaultPrompt: String(params.defaultPrompt) }
                    : {}),
                };
              if (method === "Page.javascriptDialogClosed")
                s.dialog = undefined;
              if (
                method === "Target.targetDestroyed" &&
                params?.targetId === s.devtoolsLayout?.targetId
              )
                void restoreDevToolsSession(s);
            });
            await s.cdp.send("Page.enable", {});
            if (input.mode === "managed") {
              await Promise.all([
                s.cdp.send("Emulation.setDeviceMetricsOverride", {
                  width: 1280,
                  height: 800,
                  deviceScaleFactor: 1,
                  mobile: false,
                }),
                s.cdp.send(
                  "Browser.setDownloadBehavior",
                  { behavior: "deny" },
                  false,
                ),
              ]);
              s.viewport = { width: 1280, height: 800, mobile: false };
            }
            try {
              s.driver = await BrowserDriver.connect(root, s.cdp, signal);
            } catch (e) {
              if (input.mode !== "managed")
                throw new Error(
                  "The native desktop connection could not attach browser control. Start a managed Browse session on the same host (separate login). " +
                    redact(String(e), s.endpoint),
                );
              throw e;
            }
            const driverReadyAt = Date.now();
            if (input.mode === "managed" && initialUrl !== "about:blank")
              await waitForDocumentReady(s.cdp, signal);
            await command(s, ["get", "title"], signal);
            if (input.mode === "managed" && !input.video)
              await s.cdp.startLiveCast().catch(() => {});
            s.status = "ready";
            j.output = `Fortress connected. Browser: ${chromeReadyAt-startupAt}ms; control: ${driverReadyAt-chromeReadyAt}ms; page readiness and capture setup: ${Date.now()-driverReadyAt}ms.`;
          } catch (e) {
            s.status = "error";
            s.error = redact(
              e instanceof Error ? e.message : String(e),
              s.endpoint,
            );
            s.cdp?.close();
            await s.managed?.close();
            s.managed = undefined;
            j.output = JSON.stringify(s.bridge?.trace);
            throw e;
          }
        },
        s,
        300000,
      );
    },
    keepalive: async ({ id }) => {
      const s = session(id);
      if (s.status === "ready") touchSession(s);
      return publicSession(s);
    },
    inspect: async ({ id }, ctx) => {
      const s = sessions.get(id);
      if (!s)
        return {
          id,
          status: "released" as const,
          recording: false,
          artifactRoot: join(ctx.experimental_paths.dataDir, "artifacts", id),
        };

      // Runtime evaluation is blocked while a JavaScript dialog is open. Return
      // the last streamed URL so viewer-info can surface the dialog immediately.
      const url =
        s.status === "ready" && !s.dialog
          ? await s.cdp?.evaluate("location.href").catch(() => s.frameInfo?.url)
          : s.frameInfo?.url;
      return { ...publicSession(s), url };
    },
    submit: async ({ id, operation, timeoutMs }, ctx) => {
      const s = session(id);
      const j = startJob(
        operation.kind === "command" ? operation.args[0] : operation.kind,
        ctx,
        (signal, j) => perform(s, operation, signal, j),
        s,
        timeoutMs,
      );
      await Promise.race([task(j.id).promise, sleep(400)]);
      return view(task(j.id));
    },
    job: ({ id }) => view(task(id)),
    cancel: async ({ id }) => {
      const t = task(id);
      if (t.view.status === "running") t.controller.abort();
      return view(t);
    },
    release: async ({ id }) => {
      const s = sessions.get(id);
      if (s) await release(s);
      return { released: true };
    },
    artifacts: ({ id }, ctx) => {
      if (!/^ab-[a-z0-9-]+$/.test(id)) throw new Error("Invalid session ID");
      return files(
        sessions.get(id) ?? {
          artifactRoot: join(ctx.experimental_paths.dataDir, "artifacts", id),
        },
      );
    },
    image: async ({ sessionId, artifactId }, ctx) => {
      if (!/^ab-[a-z0-9-]+$/.test(sessionId))
        throw new Error("Invalid session ID");
      const s = sessions.get(sessionId) ?? {
          artifactRoot: join(
            ctx.experimental_paths.dataDir,
            "artifacts",
            sessionId,
          ),
        },
        a = (await files(s)).find((a) => a.id === artifactId);
      if (!a || a.mime !== "image/png")
        throw new Error("PNG artifact not found");
      if (a.bytes > 4 * 1024 * 1024)
        throw new Error(
          "Image too large for inline tool output. Use its artifact link.",
        );
      return {
        base64: (await fs.readFile(a.path)).toString("base64"),
        mime: a.mime,
      };
    },
  },
  dispose: async () => {
    for (const t of jobs.values()) t.controller.abort();
    await Promise.allSettled([...sessions.values()].map(release));
  },
});
