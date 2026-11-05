// Voice tools: fast dictation for bb, transcribed on this machine (NVIDIA
// Parakeet or Whisper) or by OpenRouter.
//
// Two ways in:
// - the composer mic (app.tsx) streams audio while you talk through the
//   `dictation.*` RPC, so the text is ready moments after you stop;
// - a "voice" AI service, used for whole recordings by bb's mobile apps and
//   `bb voice transcribe`.
// Settings live on the plugin's settings page (app.tsx, `config.*` RPC). In
// local mode the host entry (host.ts) runs the speech server; in cloud mode it
// is stopped and recordings go to OpenRouter.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CloudDictation, cloudTranscribe, type CloudConfig } from "./src/cloud.js";
import {
  CLOUD_MODELS,
  DEFAULT_CONFIG,
  LANGUAGES,
  LOCAL_MODELS,
  OPENROUTER_URL,
  activeModel,
  configSchema,
  type Config,
} from "./src/config.js";
import {
  MAX_AUDIO_BYTES,
  MAX_DICTATION_MINUTES,
  MAX_STREAM_CHUNK_BYTES,
  hostContract,
  type Desired,
  type HostState,
} from "./src/contract.js";

export const SERVICE_ID = "voice-tools";
const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_RETRY_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;
/** bb waits up to 70 s for a transcript. */
const TRANSCRIBE_TIMEOUT_MS = 65_000;
const STREAM_CALL_TIMEOUT_MS = 30_000;
/** A finish waits for queued pieces; after a long dictation on a slow CPU that can take a while. */
const STREAM_FINISH_TIMEOUT_MS = 5 * 60_000;
const CLOUD_IDLE_MS = 2 * 60_000;
const CONFIG_KEY = "config";
const VOXTRAL = "mistralai/voxtral-mini-transcribe-3-0";
const CLOUD_FALLBACK = "nvidia/parakeet-tdt-0.6b-v3";
/** Voxtral answers short notes in ~0.6 s; anything slower is a long recording it will time out on. */
const VOXTRAL_LEASH_MS = 12_000;
const VOXTRAL_MAX_SECONDS = 40;

const dictationId = z.string().regex(/^[a-f0-9]{32}$/);
const dictationResult = z.object({ text: z.string(), seconds: z.number() }).strict();
const option = z.object({ id: z.string(), label: z.string() }).strict();

const settingsView = z
  .object({
    config: configSchema,
    models: z.object({ local: z.array(option), cloud: z.array(option) }).strict(),
    languages: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
    /** Never the key itself: whether one is saved, and its last 4 characters. */
    apiKey: z.object({ saved: z.boolean(), last4: z.string().nullable() }).strict(),
    status: z.object({ ready: z.boolean(), message: z.string() }).strict(),
  })
  .strict();
export type SettingsView = z.infer<typeof settingsView>;

/** What the frontend (app.tsx) calls. */
export const rpcContract = defineRpcContract({
  "dictation.start": { input: z.null(), output: z.object({ id: dictationId }).strict() },
  "dictation.audio": {
    input: z
      .object({
        id: dictationId,
        /** 16 kHz mono little-endian int16 PCM. */
        pcmBase64: z.string().min(1).max(Math.ceil((MAX_STREAM_CHUNK_BYTES * 4) / 3) + 4),
      })
      .strict(),
    output: dictationResult,
  },
  "dictation.finish": { input: z.object({ id: dictationId }).strict(), output: dictationResult },
  "dictation.cancel": { input: z.object({ id: dictationId }).strict(), output: z.object({}).strict() },
  "settings.get": { input: z.null(), output: settingsView },
  "settings.update": { input: configSchema.partial().strict(), output: settingsView },
  "settings.saveApiKey": { input: z.object({ key: z.string().min(1).max(500) }).strict(), output: settingsView },
  "settings.removeApiKey": { input: z.null(), output: settingsView },
});

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const secretsDir = path.join(bb.server.experimental_dataDir, "plugins", bb.pluginId, "secrets");
  const keyFile = path.join(secretsDir, "openrouter-api-key");

  // ── configuration and the API key ────────────────────────────────────────

  async function readApiKey(): Promise<string> {
    return (await fs.readFile(keyFile, "utf8").catch(() => "")).trim();
  }

  async function writeApiKey(key: string | null): Promise<void> {
    if (key === null) {
      await fs.rm(keyFile, { force: true });
      return;
    }
    await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(keyFile, key, { mode: 0o600 });
    await fs.chmod(keyFile, 0o600);
  }

  /** Earlier versions kept the key as a bb secret setting; move it over once. */
  async function migrateLegacyKey(): Promise<boolean> {
    const legacy = path.join(secretsDir, "cloudApiKey");
    const key = (await fs.readFile(legacy, "utf8").catch(() => "")).trim();
    if (!key) return false;
    if (!(await readApiKey())) await writeApiKey(key);
    await fs.rm(legacy, { force: true });
    return true;
  }

  async function readConfig(): Promise<Config> {
    const stored = configSchema.safeParse(await bb.storage.kv.get(CONFIG_KEY));
    if (stored.success) return stored.data;
    // First run of this version: a migrated key means cloud mode was in use.
    const config: Config = { ...DEFAULT_CONFIG, source: (await migrateLegacyKey()) ? "cloud" : "local" };
    await bb.storage.kv.set(CONFIG_KEY, config);
    return config;
  }

  type Mode =
    | { engine: "local"; desired: Desired }
    | { engine: "cloud"; cloud: CloudConfig; problem: string | null };

  async function mode(): Promise<Mode> {
    const config = await readConfig();
    if (config.source === "cloud") {
      const apiKey = await readApiKey();
      return {
        engine: "cloud",
        cloud: { url: OPENROUTER_URL, apiKey, model: config.cloudModel, language: config.language },
        problem: apiKey ? null : "Add your OpenRouter API key in Voice tools settings.",
      };
    }
    return {
      engine: "local",
      desired: { model: config.localModel, language: config.language, unloadAfterMinutes: 0 },
    };
  }

  async function hostId(): Promise<string> {
    const id = (await bb.sdk.system.config()).primaryHostId;
    if (id === null) throw new Error("No machine is connected to bb.");
    return id;
  }

  async function ensure(
    desired: Desired,
    action: "ensure" | "restart" | "reinstall",
    signal?: AbortSignal,
    timeoutMs = STATUS_TIMEOUT_MS,
  ): Promise<HostState> {
    return host.call("voiceTools.ensure", { ...desired, action }, { hostId: await hostId(), signal, timeoutMs });
  }

  async function status(): Promise<{ ready: boolean; message: string }> {
    const current = await mode();
    if (current.engine === "cloud") {
      return current.problem ? { ready: false, message: current.problem } : { ready: true, message: "Ready" };
    }
    try {
      const state = await ensure(current.desired, "ensure");
      // During a quick reload the host holds requests until the server is back.
      const ready = state.phase === "ready" || state.reloading;
      return { ready, message: ready ? "Ready" : describe(state) };
    } catch (error) {
      return { ready: false, message: "The speech engine isn't responding. Try again in a moment." };
    }
  }

  async function view(): Promise<SettingsView> {
    const key = await readApiKey();
    return {
      config: await readConfig(),
      models: { local: [...LOCAL_MODELS], cloud: [...CLOUD_MODELS] },
      languages: [...LANGUAGES],
      apiKey: { saved: key.length > 0, last4: key ? key.slice(-4) : null },
      status: await status(),
    };
  }

  /** Ask OpenRouter whether a key is valid before saving it. */
  async function checkApiKey(key: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${OPENROUTER_URL}/key`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Couldn't reach OpenRouter. Try again.");
    }
    if (response.status === 401 || response.status === 403) throw new Error("OpenRouter doesn't recognize this key.");
    if (!response.ok) throw new Error("OpenRouter couldn't check the key. Try again.");
  }

  // ── whole recordings: bb's mobile apps and `bb voice transcribe` ─────────

  bb.experimental_aiServices.register({
    id: SERVICE_ID,
    displayName: "Voice tools",
    async transcribe(audio, { signal, hint }) {
      if (audio.size > MAX_AUDIO_BYTES) throw new Error("The recording is too large.");
      const filename = audio.name || "voice-input.webm";
      const current = await mode();
      if (current.engine === "cloud") {
        if (current.problem) throw new Error(current.problem);
        if (current.cloud.model !== VOXTRAL) return cloudTranscribe(current.cloud, audio, filename, { signal, hint });
        // Voxtral times out on recordings over ~50 s, and bb sends phone
        // recordings whole. Recordings that are clearly long go straight to
        // Parakeet (3 minutes in 4 s); the rest get a short leash.
        if (estimatedSeconds(audio) > VOXTRAL_MAX_SECONDS) {
          return cloudTranscribe({ ...current.cloud, model: CLOUD_FALLBACK }, audio, filename, { signal, hint });
        }
        try {
          return await cloudTranscribe(current.cloud, audio, filename, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(VOXTRAL_LEASH_MS)]),
            hint,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          bb.log.info(`Voxtral failed (${errorMessage(error)}); retrying with Parakeet`);
          return cloudTranscribe({ ...current.cloud, model: CLOUD_FALLBACK }, audio, filename, { signal, hint });
        }
      }
      const { text } = await host.call(
        "voiceTools.transcribe",
        {
          audioBase64: Buffer.from(await audio.arrayBuffer()).toString("base64"),
          filename,
          mimeType: audio.type,
          hint: hint === null ? null : hint.slice(0, 2_000),
        },
        { hostId: await hostId(), signal, timeoutMs: TRANSCRIBE_TIMEOUT_MS },
      );
      return text;
    },
    async status() {
      const current = await status();
      return current.ready ? { ready: true } : { ready: false, message: current.message };
    },
  });

  // ── live dictation and the settings page ─────────────────────────────────

  /** Cloud dictations live here; local ones live in the speech server. */
  const cloudDictations = new Map<string, CloudDictation>();
  const maxDictationSeconds = MAX_DICTATION_MINUTES * 60;

  function dropIdleCloudDictations(): void {
    const now = Date.now();
    for (const [id, dictation] of cloudDictations) {
      if (now - dictation.touched > CLOUD_IDLE_MS) {
        dictation.cancel();
        cloudDictations.delete(id);
      }
    }
  }

  bb.rpc.register(rpcContract, {
    async "dictation.start"() {
      const current = await mode();
      if (current.engine === "cloud") {
        if (current.problem) throw new Error(current.problem);
        dropIdleCloudDictations();
        // Open the TLS connection now, while the user talks, not at stop.
        void fetch(`${OPENROUTER_URL}/key`, {
          headers: { authorization: `Bearer ${current.cloud.apiKey}` },
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});
        const id = randomUUID().replaceAll("-", "");
        cloudDictations.set(id, new CloudDictation(current.cloud));
        return { id };
      }
      return host.call("voiceTools.stream.start", {}, { hostId: await hostId(), timeoutMs: STREAM_CALL_TIMEOUT_MS });
    },
    async "dictation.audio"({ id, pcmBase64 }) {
      const cloud = cloudDictations.get(id);
      if (cloud !== undefined) {
        if (cloud.seconds > maxDictationSeconds) throw new Error(`Dictation is limited to ${MAX_DICTATION_MINUTES} minutes.`);
        cloud.append(Buffer.from(pcmBase64, "base64"));
        return { text: "", seconds: cloud.seconds };
      }
      return host.call("voiceTools.stream.audio", { id, pcmBase64 }, { hostId: await hostId(), timeoutMs: STREAM_CALL_TIMEOUT_MS });
    },
    async "dictation.finish"({ id }) {
      const cloud = cloudDictations.get(id);
      if (cloud !== undefined) {
        cloudDictations.delete(id);
        // Voxtral times out past ~50 s; longer dictations go to Parakeet in one pass.
        const model = cloud.seconds > VOXTRAL_MAX_SECONDS && cloud.model === VOXTRAL ? CLOUD_FALLBACK : undefined;
        return { text: await cloud.finish(model), seconds: cloud.seconds };
      }
      return host.call("voiceTools.stream.finish", { id }, { hostId: await hostId(), timeoutMs: STREAM_FINISH_TIMEOUT_MS });
    },
    async "dictation.cancel"({ id }) {
      const cloud = cloudDictations.get(id);
      if (cloud !== undefined) {
        cloud.cancel();
        cloudDictations.delete(id);
        return {};
      }
      await host.call("voiceTools.stream.cancel", { id }, { hostId: await hostId(), timeoutMs: STATUS_TIMEOUT_MS });
      return {};
    },
    "settings.get": view,
    async "settings.update"(patch) {
      const next = configSchema.parse({ ...(await readConfig()), ...patch });
      await bb.storage.kv.set(CONFIG_KEY, next);
      wakeReconcile();
      return view();
    },
    async "settings.saveApiKey"({ key }) {
      const trimmed = key.trim();
      await checkApiKey(trimmed);
      await writeApiKey(trimmed);
      return view();
    },
    async "settings.removeApiKey"() {
      await writeApiKey(null);
      return view();
    },
  });

  // ── keep the host in line with the configuration ─────────────────────────
  // Local: install and run the speech server. Cloud: stop it, so it holds no
  // memory or CPU.

  let wake: (() => void) | null = null;
  function wakeReconcile(): void {
    wake?.();
  }
  host.experimental_onWorkerExit(wakeReconcile);
  let lastProblem: string | null = null;
  bb.background.service("reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        let delay = RECONCILE_INTERVAL_MS;
        try {
          const current = await mode();
          if (current.engine === "cloud") {
            await host.call("voiceTools.stop", {}, { hostId: await hostId(), signal, timeoutMs: STATUS_TIMEOUT_MS });
            lastProblem = null;
          } else {
            const state = await ensure(current.desired, "ensure", signal);
            const problem =
              state.phase === "failed" || state.phase === "unsupported" ? `${describe(state)} (${state.message})` : null;
            if (problem !== null && problem !== lastProblem) bb.log.warn(problem);
            lastProblem = problem;
          }
        } catch (error) {
          if (signal.aborted) break;
          const problem = `Could not reach the Voice tools host: ${errorMessage(error)}`;
          if (problem !== lastProblem) bb.log.warn(problem);
          lastProblem = problem;
          delay = RECONCILE_RETRY_MS;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, delay);
          wake = done;
          signal.addEventListener("abort", done, { once: true });
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake = null;
            resolve();
          }
        });
      }
    },
  });

  // ── `bb voice-tools` ──────────────────────────────────────────────────────

  bb.cli.register(
    defineCli({
      name: "voice-tools",
      summary: "Check and manage Voice tools transcription",
      commands: {
        status: cliCommand({
          summary: "Show what transcribes and whether it is ready",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run(input) {
            const config = await readConfig();
            const summary = await status();
            const model = activeModel(config);
            const where = config.source === "cloud" ? "OpenRouter" : "this machine";
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ ...summary, ...config, model: model.id }) };
            }
            return {
              exitCode: 0,
              stdout: [
                `Status:    ${summary.message}`,
                `Source:    ${where}`,
                `Model:     ${model.label} (${model.id})`,
                `Language:  ${LANGUAGES.find((l) => l.id === config.language)?.label ?? config.language}`,
                config.source === "cloud" ? `API key:   ${(await readApiKey()) ? "saved" : "missing"}` : null,
                `Settings:  Settings → Plugins → Voice tools`,
              ]
                .filter((line) => line !== null)
                .join("\n"),
            };
          },
        }),
        restart: cliCommand({
          summary: "Restart the local speech server (reloads the model)",
          async run() {
            const state = await requireLocal((desired) => ensure(desired, "restart"));
            return { exitCode: 0, stdout: `${describe(state)}\nFollow progress with: bb voice-tools status` };
          },
        }),
        reinstall: cliCommand({
          summary: "Rebuild the local Python environment from scratch, then start the speech server",
          async run() {
            const state = await requireLocal((desired) => ensure(desired, "reinstall", undefined, 30_000));
            return {
              exitCode: 0,
              stdout: `${describe(state)}\nThis takes a few minutes. Follow progress with: bb voice-tools status`,
            };
          },
        }),
        logs: cliCommand({
          summary: "Print the tail of the local install and server logs",
          options: {
            lines: {
              type: "integer",
              min: 1,
              max: 500,
              default: 40,
              aliases: ["tail"],
              description: "Lines per log, 1-500",
            },
          },
          async run(input) {
            let id: string;
            try {
              id = await hostId();
            } catch (error) {
              throw new PluginCliError(errorMessage(error), { code: "no_primary_host" });
            }
            const { text } = await host.call("voiceTools.logs", { lines: input.options.lines }, { hostId: id, timeoutMs: STATUS_TIMEOUT_MS });
            return { exitCode: 0, stdout: text };
          },
        }),
      },
    }),
  );

  async function requireLocal(run: (desired: Desired) => Promise<HostState>): Promise<HostState> {
    const current = await mode();
    if (current.engine === "cloud") {
      throw new PluginCliError("Voice tools is set to OpenRouter, so the local speech server is off", {
        code: "cloud_mode",
        hint: "Switch the source in Settings → Plugins → Voice tools",
      });
    }
    return run(current.desired);
  }
}

/** Status in one short sentence, for the settings page and bb's voice picker. */
function describe(state: HostState): string {
  switch (state.phase) {
    case "ready":
      return "Ready";
    case "installing":
      return "Installing the speech engine. The first install takes a few minutes.";
    case "starting":
      return "Loading the speech model.";
    case "failed":
      return "The speech engine failed to start. Run bb voice-tools reinstall.";
    case "unsupported":
      return "This machine can't run local models. Use OpenRouter instead.";
    case "idle":
      return "The speech engine is off.";
  }
}

/**
 * Rough length of a compressed recording from its size, erring long: Opus in
 * WebM/Ogg runs ~4 KB/s, AAC in MP4 ~8 KB/s, 16 kHz WAV 32 KB/s.
 */
function estimatedSeconds(audio: Blob): number {
  const type = audio.type.toLowerCase();
  const bytesPerSecond = type.includes("wav") ? 32_000 : type.includes("mp4") || type.includes("m4a") || type.includes("aac") ? 8_000 : 4_000;
  return audio.size / bytesPerSecond;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
