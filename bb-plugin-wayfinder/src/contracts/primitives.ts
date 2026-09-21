import { z } from "zod";

const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const entityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(ENTITY_ID_PATTERN, "Expected a bounded opaque identifier");

export const sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, "Expected a lowercase SHA-256 digest");

export const unixMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const boundedMessageSchema = z.string().trim().min(1).max(1_000);

export const jsonScalarSchema = z.union([
  z.string().max(8_192),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const base64Schema = z
  .string()
  .max(1_500_000)
  .regex(BASE64_PATTERN, "Expected bounded base64 data");

function parseHttpOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username !== '' || url.password !== '') return null;
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
    if (url.origin !== value) return null;
    return url;
  } catch {
    return null;
  }
}

function isLiteralPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1" || normalized === "0.0.0.0" || normalized === "169.254.169.254") return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = -1, b = -1] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export const httpOriginSchema = z
  .string()
  .max(2_048)
  .refine((value) => parseHttpOrigin(value) !== null, "Expected a canonical HTTP(S) origin");

export const allowedOriginSchema = z
  .object({
    origin: httpOriginSchema,
    purpose: z.enum(["external", "fixture"]),
  })
  .strict()
  .superRefine(({ origin, purpose }, context) => {
    const url = parseHttpOrigin(origin);
    if (url !== null && purpose === "external" && isLiteralPrivateHost(url.hostname)) {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "Literal private and metadata origins require purpose=fixture",
      });
    }
  });

export const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value.startsWith("/") && value !== "/" && !value.endsWith("/") && !value.includes("\0"),
    "Expected a non-root absolute POSIX path without a trailing slash",
  )
  .refine(
    (value) => value.split("/").slice(1).every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Empty and dot segments are forbidden",
  );

export const relativePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Expected a normalized relative path without traversal",
  );

export const rectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

export type JsonScalar = z.infer<typeof jsonScalarSchema>;
