import { artifactHttpRoutes } from "../src/contracts/artifact.js";
import { liveHttpRoutes } from "../src/media/routes.js";

export const PLUGIN_ID = "wayfinder";
const HTTP_BASE = `/api/v1/plugins/${PLUGIN_ID}/http`;

/** Same-origin, authenticated (`auth: "local"`) artifact URL scoped to the viewing thread. */
export function artifactUrl(kind: "inline" | "download", artifactId: string, threadId: string): string {
  const params = new URLSearchParams({ artifactId, threadId });
  return `${HTTP_BASE}${artifactHttpRoutes[kind]}?${params.toString()}`;
}

export function liveFrameUrl(runId: string, afterSequence: number | null): string {
  const params = new URLSearchParams({ runId });
  if (afterSequence !== null) params.set("after", String(afterSequence));
  return `${HTTP_BASE}${liveHttpRoutes.frame}?${params.toString()}`;
}

/** Absolute private link for "copy link" fallbacks; it still requires BB sign-in. */
export function absoluteUrl(relative: string): string {
  return new URL(relative, globalThis.location?.origin ?? "http://localhost").toString();
}
