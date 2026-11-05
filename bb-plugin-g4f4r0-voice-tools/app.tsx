// Voice tools frontend: bb's own mic and recording bar, driven by live
// dictation. Recognized text is written into the draft while you talk, piece
// by piece, so stopping only adds the last few words.
//
// The mic is a plain bb-styled button (no preferences menu); while recording, a compact
// bar (cancel, waveform, timer, confirm) takes the composer's action row the
// way bb's own recording bar does.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useComposer,
  useRpc,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { SettingsView, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dictation,
  allowMicrophoneAccess,
  chooseMicrophone,
  chosenMicrophone,
  listMicrophones,
  type DictationTransport,
  type Microphone,
} from "./src/dictation";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const NATIVE_MIC = 'button[aria-label="Start voice input"]:not([data-voice-tools]), button[aria-label^="Microphone warning"]:not([data-voice-tools])';
const ACTION_ROW = "[data-promptbox-action-row]";
const REPLACES_ATTR = "data-voice-tools-replaces-mic";
const RECORDING_ATTR = "data-voice-tools-recording";
/** bb's classes for its mic and for the voice-controls overlay. */
const MIC_CLASS = "size-8 rounded-md p-0 max-md:pointer-coarse:size-10";
const OVERLAY_CLASS =
  "absolute inset-0 z-10 min-w-0 origin-center transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[opacity,transform] motion-reduce:transition-none pointer-events-auto translate-y-0 scale-100 opacity-100";

// ── one Dictation per composer, shared by the mic and the command ─────────

let rpcClient: Rpc | null = null;
const dictations = new Map<string, Dictation>();
/** Text of the current dictation already written into each composer's draft. */
const written = new Map<string, string>();

function transportFor(rpc: Rpc): DictationTransport {
  return {
    start: () => rpc.call("dictation.start"),
    audio: (id, pcmBase64) => rpc.call("dictation.audio", { id, pcmBase64 }),
    finish: (id) => rpc.call("dictation.finish", { id }),
    cancel: async (id) => {
      await rpc.call("dictation.cancel", { id });
    },
  };
}

function dictationFor(key: string): Dictation | null {
  let found = dictations.get(key);
  if (!found && rpcClient) {
    found = new Dictation(transportFor(rpcClient));
    dictations.set(key, found);
  }
  return found ?? null;
}

const IDLE = { phase: "idle", seconds: 0, liveText: "", stream: null } as const;

function useDictation(key: string) {
  const dictation = dictationFor(key);
  const state = useSyncExternalStore(
    (listener) => dictation?.subscribe(listener) ?? (() => {}),
    () => dictation?.state ?? IDLE,
  );
  return { dictation, state };
}

/**
 * Write whatever part of `text` is not in the draft yet. The server's text
 * only grows (pieces are appended), so the new part is the suffix.
 */
function writeProgress(composer: PluginComposerApi, text: string): void {
  const done = written.get(composer.key) ?? "";
  if (!text.startsWith(done) || text.length === done.length) return;
  let addition = text.slice(done.length);
  if (done === "") {
    addition = addition.trimStart();
    if (composer.text.length > 0 && !/\s$/.test(composer.text)) addition = ` ${addition}`;
  }
  written.set(composer.key, text);
  try {
    composer.insert(addition);
  } catch {
    composer.insert(addition, { at: "end" });
  }
}

async function start(composer: PluginComposerApi): Promise<void> {
  const dictation = dictationFor(composer.key);
  if (!dictation) return;
  written.set(composer.key, "");
  try {
    await dictation.start();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function stop(composer: PluginComposerApi): Promise<void> {
  const dictation = dictationFor(composer.key);
  if (!dictation || dictation.state.phase !== "recording") return;
  try {
    const text = await dictation.stop();
    writeProgress(composer, text);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    written.delete(composer.key);
  }
}

/**
 * Cancel: remove what this dictation wrote, when it is still where it was
 * written and nothing (no mention) follows it; text the user edited stays.
 */
function discard(composer: PluginComposerApi): void {
  const text = (written.get(composer.key) ?? "").trim();
  written.delete(composer.key);
  if (!text) return;
  composer.replace((current) => {
    const at = current.text.lastIndexOf(text);
    if (at < 0 || current.mentions.some((mention) => mention.to > at)) return current;
    const before = current.text.slice(0, at).replace(/ $/, "");
    return { text: before + current.text.slice(at + text.length), mentions: current.mentions };
  });
}

async function toggle(composer: PluginComposerApi): Promise<void> {
  const phase = dictationFor(composer.key)?.state.phase;
  if (phase === "idle") await start(composer);
  else if (phase === "recording") await stop(composer);
}

// ── the mic and, while recording, bb's recording bar ──────────────────────

function Mic() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  rpcClient ??= rpc;
  const { dictation, state } = useDictation(composer.key);
  const anchor = useRef<HTMLSpanElement>(null);
  const [row, setRow] = useState<HTMLElement | null>(null);

  // Write recognized pieces into the draft as they arrive.
  useEffect(() => {
    if (state.phase === "recording" || state.phase === "finishing") writeProgress(composer, state.liveText);
  }, [composer, state.phase, state.liveText]);

  // Find this composer's action row: the overlay mounts there, and bb's own
  // mic (rendered only while a voice service is ready) is hidden there.
  useEffect(() => {
    const find = () => {
      const found = anchor.current?.closest<HTMLElement>(ACTION_ROW) ?? null;
      setRow((current) => (current === found ? current : found));
    };
    find();
    // The row rarely changes; a slow check is enough and costs nothing.
    const timer = window.setInterval(find, 5_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!row) return;
    row.setAttribute(REPLACES_ATTR, "");
    return () => row.removeAttribute(REPLACES_ATTR);
  }, [row]);

  const active = state.phase === "recording" || state.phase === "finishing";
  useEffect(() => {
    if (!row || !active) return;
    row.setAttribute(RECORDING_ATTR, "");
    return () => row.removeAttribute(RECORDING_ATTR);
  }, [row, active]);

  return (
    <span ref={anchor} style={{ display: "contents" }}>
      <Button
        data-voice-tools=""
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Start voice input"
        className={MIC_CLASS}
        disabled={state.phase !== "idle" || !dictation}
        onClick={() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          void start(composer);
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Icon name="Mic" className="size-4" />
      </Button>
      {row && active && dictation
        ? createPortal(
            <div data-voice-tools-controls="" className={OVERLAY_CLASS}>
              <RecordingBar
                stream={state.stream}
                finishing={state.phase === "finishing"}
                onConfirm={() => void stop(composer)}
                onCancel={() => {
                  discard(composer);
                  void dictation.cancel();
                }}
              />
            </div>,
            row,
          )
        : null}
    </span>
  );
}

// ── recording bar: ✕, waveform, timer, ✓ ──────────────────────────────────

const BAR_WIDTH = 8; // Tailwind w-2
const BAR_GAP = 2; // Tailwind gap-0.5
const BAR_RADIUS = 2; // Tailwind rounded-sm
const SAMPLE_MS = 60;

/** Live waveform: one rounded bar per 60 ms of input level, newest on the right. */
function Waveform({ stream }: { stream: MediaStream | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !stream) return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const levels: number[] = [];
    let frame = 0;
    let last = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < SAMPLE_MS) return;
      last = now;
      analyser.getFloatTimeDomainData(samples);
      let power = 0;
      for (const v of samples) power += v * v;
      // sqrt of RMS reads closer to perceived loudness than RMS itself.
      levels.push(Math.min(1, Math.sqrt(Math.sqrt(power / samples.length)) * 2.6));

      const ratio = window.devicePixelRatio || 1;
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (el.width !== Math.round(width * ratio)) el.width = Math.round(width * ratio);
      if (el.height !== Math.round(height * ratio)) el.height = Math.round(height * ratio);
      const g = el.getContext("2d");
      if (!g) return;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, width, height);
      g.fillStyle = getComputedStyle(el).color;
      const count = Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP));
      if (levels.length > count) levels.splice(0, levels.length - count);
      for (let i = 0; i < count; i++) {
        const level = levels[levels.length - count + i] ?? 0;
        const h = Math.max(BAR_WIDTH, level * height);
        const x = i * (BAR_WIDTH + BAR_GAP);
        g.beginPath();
        g.roundRect(x, (height - h) / 2, BAR_WIDTH, h, BAR_RADIUS);
        g.fill();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      void context.close();
    };
  }, [stream]);

  return <canvas ref={canvas} aria-hidden className="h-6 min-w-0 flex-1 text-muted-foreground/70" />;
}

function RecordingBar({
  stream,
  finishing,
  onConfirm,
  onCancel,
}: {
  stream: MediaStream | null;
  finishing: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-row items-center gap-3 px-2 py-1.5">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Cancel dictation"
        className="size-8 shrink-0 rounded-md p-0 max-md:pointer-coarse:size-10"
        disabled={finishing}
        onClick={onCancel}
      >
        <Icon name="X" className="size-4" />
      </Button>
      <Waveform stream={stream} />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-live="off">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </span>
      <Button
        type="button"
        size="icon"
        aria-label={finishing ? "Transcribing" : "Add to draft"}
        className="size-8 shrink-0 rounded-md p-0 max-md:pointer-coarse:size-10"
        disabled={finishing}
        onClick={onConfirm}
      >
        <Icon name={finishing ? "Spinner" : "Check"} className={finishing ? "size-4 animate-spin" : "size-4"} />
      </Button>
    </div>
  );
}

// ── settings page ─────────────────────────────────────────────────────────
// Drawn with bb's own settings-form classes so it reads as one bb form:
// source, then the model list for that source, the OpenRouter key (cloud
// only, with Save), and language.

const CARD = "overflow-hidden rounded-md border border-border bg-surface-recessed/70 px-3 py-3";
const ROW =
  "flex flex-col gap-2.5 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-start @min-[36rem]/settings:justify-between @min-[36rem]/settings:gap-5";
const LABEL = "min-w-0 text-sm font-normal text-foreground";
const HINT = "mt-0.5 text-xs leading-snug text-subtle-foreground/75";
const CONTROL = "shrink-0 @min-[36rem]/settings:flex @min-[36rem]/settings:justify-end";
const TRIGGER = "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs @min-[36rem]/settings:w-56";
const INPUT = "h-7 w-full text-xs @min-[36rem]/settings:w-56";

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={ROW}>
      <div className="min-w-0 flex-1">
        <p className={LABEL}>{label}</p>
        {hint ? <p className={HINT}>{hint}</p> : null}
      </div>
      <div className={CONTROL}>{children}</div>
    </div>
  );
}

function Choice({
  value,
  options,
  label,
  onChange,
}: {
  value: string;
  options: readonly { id: string; label: string }[];
  label: string;
  onChange(value: string): void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={TRIGGER} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const DEFAULT_MIC = "__default__";

/** Per-browser microphone choice; same list bb's voice preferences show. */
function MicrophoneRow() {
  const [mics, setMics] = useState<Microphone[]>([]);
  const [labelled, setLabelled] = useState(true);
  const [chosen, setChosen] = useState<string>(chosenMicrophone() ?? DEFAULT_MIC);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    listMicrophones().then(
      (result) => {
        setMics(result.microphones);
        setLabelled(result.labelled);
      },
      () => setError("This browser doesn't list microphones."),
    );

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError("This browser doesn't list microphones.");
      return;
    }
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, []);

  const options = [{ id: DEFAULT_MIC, label: "System default" }, ...mics.map((m) => ({ id: m.deviceId, label: m.label }))];
  // A saved device that is unplugged right now still shows, so the choice isn't lost.
  if (chosen !== DEFAULT_MIC && !mics.some((m) => m.deviceId === chosen)) {
    options.push({ id: chosen, label: "Saved microphone (not connected)" });
  }

  return (
    <Row label="Microphone" hint={error ?? undefined}>
      {labelled || error ? (
        <Choice
          label="Microphone"
          value={chosen}
          options={options}
          onChange={(id) => {
            setChosen(id);
            chooseMicrophone(id === DEFAULT_MIC ? null : id);
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          onClick={() =>
            void allowMicrophoneAccess().then(refresh, () => setError("Microphone access is blocked. Allow it in your browser's site settings."))
          }
        >
          Show microphones
        </Button>
      )}
    </Row>
  );
}

const SOURCES = [
  { id: "local", label: "This machine" },
  { id: "cloud", label: "OpenRouter" },
] as const;

function SettingsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = () =>
      rpc.call("settings.get").then(
        (next) => {
          if (cancelled) return;
          setView(next);
          // Installing or loading the model: keep the status line current.
          if (!next.status.ready && next.config.source === "local") timer = window.setTimeout(load, 3_000);
        },
        () => {
          if (!cancelled) timer = window.setTimeout(load, 5_000);
        },
      );
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rpc, view?.config.source, view?.config.localModel]);

  if (!view) return <div className={CARD}><p className={HINT}>Loading…</p></div>;

  const { config } = view;
  const cloud = config.source === "cloud";
  const models = cloud ? view.models.cloud : view.models.local;
  const model = models.find((m) => m.id === (cloud ? config.cloudModel : config.localModel));
  const showKeyInput = cloud && (!view.apiKey.saved || editingKey);

  const update = (patch: Partial<SettingsView["config"]>) =>
    rpc.call("settings.update", patch).then(setView, (error: unknown) => toast.error(errorText(error)));

  const saveKey = async () => {
    if (!draftKey.trim()) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      setView(await rpc.call("settings.saveApiKey", { key: draftKey }));
      setDraftKey("");
      setEditingKey(false);
      toast.success("API key saved");
    } catch (error) {
      setKeyError(errorText(error));
    } finally {
      setSavingKey(false);
    }
  };

  const removeKey = () =>
    rpc.call("settings.removeApiKey").then((next) => {
      setView(next);
      setEditingKey(false);
    });

  return (
    <div className={CARD}>
      <div className="@container/settings w-full min-w-0 space-y-4">
        <Row label="Source">
          <Choice label="Source" value={config.source} options={SOURCES} onChange={(source) => void update({ source: source as "local" | "cloud" })} />
        </Row>

        <Row label="Model">
          <Choice
            label="Model"
            value={model?.id ?? ""}
            options={models}
            onChange={(id) => void update(cloud ? { cloudModel: id } : { localModel: id as SettingsView["config"]["localModel"] })}
          />
        </Row>

        {cloud ? (
          <Row
            label="OpenRouter API key"
            hint={
              keyError ?? (
                <>
                  Get one at{" "}
                  <a className="underline underline-offset-2" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                    openrouter.ai/keys
                  </a>
                  .
                </>
              )
            }
          >
            {showKeyInput ? (
              <form
                className="flex w-full items-center gap-1.5 @min-[36rem]/settings:w-auto"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveKey();
                }}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="sk-or-…"
                  aria-label="OpenRouter API key"
                  aria-invalid={keyError ? true : undefined}
                  className={INPUT + " @min-[36rem]/settings:w-44"}
                  value={draftKey}
                  onChange={(event) => {
                    setDraftKey(event.target.value);
                    setKeyError(null);
                  }}
                />
                <Button type="submit" size="sm" className="h-7 px-2.5 text-xs" disabled={!draftKey.trim() || savingKey}>
                  {savingKey ? "Checking…" : "Save"}
                </Button>
                {view.apiKey.saved ? (
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditingKey(false)}>
                    Cancel
                  </Button>
                ) : null}
              </form>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground tabular-nums">•••• {view.apiKey.last4}</span>
                <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setEditingKey(true)}>
                  Replace
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void removeKey()}>
                  Remove
                </Button>
              </div>
            )}
          </Row>
        ) : null}

        <MicrophoneRow />

        <Row label="Language">
          <Choice label="Language" value={config.language} options={view.languages} onChange={(language) => void update({ language })} />
        </Row>

        {!view.status.ready ? <p className={HINT}>{view.status.message}</p> : null}
      </div>
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    component: SettingsPage,
  });

  app.composer.customize({
    id: "dictation",
    actions: [{ id: "mic", component: Mic }],
  });

  app.composer.experimental_registerCommand({
    id: "toggle-dictation",
    title: "Start or stop dictation (Voice tools)",
    defaultShortcut: { key: "d", mod: true, shift: true },
    run: ({ composer }) => toggle(composer),
  });

  // bb's own mic is hidden where ours replaces it, and while dictating the
  // row's other actions fade out exactly as bb does for its recording bar.
  app.contentScripts.register({
    id: "voice-tools-styles",
    mount() {
      const style = document.createElement("style");
      style.dataset.voiceTools = "";
      style.textContent = [
        `[${REPLACES_ATTR}] :is(${NATIVE_MIC}) { display: none !important; }`,
        `[${RECORDING_ATTR}] > [data-promptbox-standard-actions] { opacity: 0 !important; transform: translateY(0.25rem) !important; pointer-events: none !important; }`,
      ].join("\n");
      document.head.appendChild(style);
      return () => style.remove();
    },
  });
});
