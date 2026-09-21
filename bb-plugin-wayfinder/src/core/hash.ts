import { createHash, randomBytes } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: unknown): string {
  const input = typeof value === "string" ? value : stableJson(value);
  return createHash("sha256").update(input).digest("hex");
}

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}
