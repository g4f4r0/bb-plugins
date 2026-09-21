import type { WayfinderRoute } from "../contracts/route.js";
import { wayfinderError } from "../core/errors.js";

export type UrlUse = "navigation" | "resource";

function normalizeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw wayfinderError("policy-denied", "act", "Malformed URL was denied");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw wayfinderError("policy-denied", "act", "Only credential-free HTTP(S) URLs are allowed");
  }
  return url;
}

export function assertAllowedUrl(route: WayfinderRoute, raw: string, use: UrlUse): URL {
  const url = normalizeUrl(raw);
  const allowed = use === "navigation" ? route.browser.navigationOrigins : route.browser.resourceOrigins;
  if (!allowed.some(({ origin }) => origin === url.origin)) {
    throw wayfinderError("policy-denied", "act", `${use === "navigation" ? "Navigation" : "Resource"} origin is not allowed`, {
      details: [{ key: "origin", value: url.origin }],
    });
  }
  return url;
}

export function assertRedirectAllowed(route: WayfinderRoute, from: string, to: string): void {
  assertAllowedUrl(route, from, "navigation");
  assertAllowedUrl(route, to, "navigation");
}

function privateAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase();
  if (isIP(normalized) === 4) {
    const [a = -1, b = -1] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(normalized) === 6) {
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

export async function assertResolvedUrlAllowed(
  route: WayfinderRoute,
  raw: string,
  use: UrlUse,
  resolver: typeof lookup = lookup,
): Promise<URL> {
  const url = assertAllowedUrl(route, raw, use);
  const entry = (use === "navigation" ? route.browser.navigationOrigins : route.browser.resourceOrigins)
    .find((allowed) => allowed.origin === url.origin);
  if (entry?.purpose === "fixture") return url;
  const addresses = await resolver(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) {
    throw wayfinderError("policy-denied", "act", "External origin resolved to a private, loopback, link-local, or unknown address");
  }
  return url;
}
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
