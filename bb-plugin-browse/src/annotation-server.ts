import { randomUUID } from "node:crypto";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  annotation,
  annotationContext,
  annotationLabel,
  annotationPoint,
  annotationSelectors,
  type Annotation,
} from "./annotation";
import { hostContract, id, type Session } from "./contracts";
import { redact } from "./policy";

type HostClient = ExperimentalHostClient<typeof hostContract>;

const KEY = "annotation:";
const RETENTION_MS = 7 * 24 * 3600_000;
const PER_SESSION = 100;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const comment = z.string().max(4000);
const annotationId = annotation.shape.id;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Viewer routes and the composer mention provider behind browser annotations. */
export async function registerAnnotations(
  bb: BbPluginApi,
  host: HostClient,
  get: (id: string) => Session,
) {
  const annotations = new Map<string, Annotation>();
  for (const key of await bb.storage.kv.list(KEY)) {
    const name = typeof key === "string" ? key : (key as { key: string }).key;
    const parsed = annotation.safeParse(await bb.storage.kv.get(name));
    if (parsed.success && Date.now() - parsed.data.createdAt < RETENTION_MS)
      annotations.set(parsed.data.id, parsed.data);
    else await bb.storage.kv.delete(name);
  }
  const store = (value: Annotation) => {
    annotations.set(value.id, value);
    return bb.storage.kv.set(KEY + value.id, value);
  };
  const remove = (value: Annotation) => {
    annotations.delete(value.id);
    return bb.storage.kv.delete(KEY + value.id);
  };
  const forSession = (sessionId: string) =>
    [...annotations.values()]
      .filter((value) => value.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  const owned = (sessionId: string, annotationKey: string) => {
    const value = annotations.get(annotationKey);
    if (!value || value.sessionId !== sessionId)
      throw new Error("Annotation not found.");
    return value;
  };
  const summary = (value: Annotation) => ({
    id: value.id,
    label: annotationLabel(value),
    comment: value.comment,
    selector: value.target.selector,
    rect: value.target.rect,
    anchor: value.anchor,
  });
  const fail = (e: unknown) => ({ error: redact(e instanceof Error ? e.message : String(e)) });

  bb.http.route("POST", "/annotation-target", async (c) => {
    try {
      const input = z.object({ id }).extend(annotationPoint.shape).parse(await c.req.json());
      const s = get(input.id);
      return c.json(await host.call("annotationTarget", input, { hostId: s.hostId, timeoutMs: 4000 }));
    } catch (e) {
      return c.json(fail(e), 409);
    }
  });
  bb.http.route("POST", "/annotation-rects", async (c) => {
    try {
      const input = z.object({ id, selectors: annotationSelectors }).parse(await c.req.json());
      const s = get(input.id);
      return c.json({ rects: await host.call("annotationRects", input, { hostId: s.hostId, timeoutMs: 4000 }) });
    } catch (e) {
      return c.json(fail(e), 409);
    }
  });
  bb.http.route("GET", "/annotations", (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const s = get(id.parse(c.req.query("id")));
      return c.json({ annotations: forSession(s.id).map(summary) });
    } catch (e) {
      return c.json(fail(e), 404);
    }
  });
  bb.http.route("POST", "/annotations", async (c) => {
    try {
      const input = z.object({ id, comment }).extend(annotationPoint.shape).parse(await c.req.json());
      const s = get(input.id);
      const existing = forSession(s.id);
      if (existing.length >= PER_SESSION)
        throw new Error(`This page already has ${PER_SESSION} annotations. Delete some first.`);
      const found = await host.call("annotationTarget", input, { hostId: s.hostId, timeoutMs: 4000 });
      if (!found.target) throw new Error("No element at that point.");
      const key = `a${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
      const shot = await host
        .call("annotationCapture", { id: s.id, rect: found.target.rect, name: `annotation-${key}.png` }, { hostId: s.hostId, timeoutMs: 8000 })
        .catch((e) => {
          bb.log.warn(`Annotation screenshot failed: ${redact(String(e))}`);
          return { path: null };
        });
      const value: Annotation = {
        id: key,
        sessionId: s.id,
        threadId: s.threadId,
        hostId: s.hostId,
        pageUrl: found.url,
        pageTitle: found.title,
        comment: input.comment.trim(),
        target: found.target,
        anchor: {
          x: clamp((input.x - found.target.rect.x) / (found.target.rect.width || 1)),
          y: clamp((input.y - found.target.rect.y) / (found.target.rect.height || 1)),
        },
        screenshotPath: shot.path,
        createdAt: Date.now(),
      };
      await store(value);
      return c.json({ annotation: summary(value) });
    } catch (e) {
      return c.json(fail(e), 409);
    }
  });
  bb.http.route("POST", "/annotation-update", async (c) => {
    try {
      const input = z.object({ id, annotationId, comment }).parse(await c.req.json());
      const value = owned(get(input.id).id, input.annotationId);
      value.comment = input.comment.trim();
      await store(value);
      return c.json({ annotation: summary(value) });
    } catch (e) {
      return c.json(fail(e), 409);
    }
  });
  bb.http.route("POST", "/annotation-delete", async (c) => {
    try {
      const input = z.object({ id, annotationId }).parse(await c.req.json());
      await remove(owned(get(input.id).id, input.annotationId));
      return c.json({ ok: true });
    } catch (e) {
      return c.json(fail(e), 409);
    }
  });
  bb.http.route("GET", "/annotation-voice", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const config = await bb.sdk.system.config();
      return c.json({ enabled: config.voiceTranscriptionEnabled });
    } catch {
      return c.json({ enabled: false });
    }
  });
  bb.http.route("POST", "/annotation-transcribe", async (c) => {
    try {
      const input = z
        .object({ id, type: z.string().regex(/^audio\/[\w.+-]+(;[\w=.+ -]*)?$/), audio: z.string().min(1).max(Math.ceil(MAX_AUDIO_BYTES / 3) * 4) })
        .parse(await c.req.json());
      get(input.id);
      const file = new Blob([Buffer.from(input.audio, "base64")], { type: input.type });
      if (!file.size) throw new Error("No audio was recorded.");
      const result = await bb.sdk.system.transcribeVoice({ file });
      return c.json({ text: result.text.trim() });
    } catch (e) {
      return c.json(fail(e), 409);
    }
  });

  bb.ui.registerMentionProvider({
    id: "annotation",
    label: "Browser annotations",
    search: ({ query, threadId }) => {
      const needle = query.trim().toLowerCase();
      return [...annotations.values()]
        .filter((value) => !threadId || value.threadId === threadId)
        .filter((value) =>
          !needle ||
          `${annotationLabel(value)} ${value.comment} ${value.pageUrl}`.toLowerCase().includes(needle),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map((value) => ({
          id: value.id,
          title: annotationLabel(value),
          subtitle: value.comment || value.pageUrl,
          icon: "MessageSquare",
        }));
    },
    resolve: (itemId) => {
      const value = annotations.get(itemId);
      return {
        context: value
          ? annotationContext(value)
          : `<browser_annotation id="${itemId.replace(/[^a-zA-Z0-9_-]/g, "")}">The user deleted this annotation before sending; ignore it.</browser_annotation>`,
      };
    },
  });
}
