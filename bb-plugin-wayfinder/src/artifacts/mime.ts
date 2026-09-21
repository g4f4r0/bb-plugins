/**
 * Artifact MIME allowlist and content sniffing. Only these types are stored;
 * only images and MP4 video may ever render inline. Everything else, including
 * HTML reports, is served as a sandboxed attachment so it can never execute in
 * BB's origin.
 */

export const ARTIFACT_MIME_TYPES = {
  "image/png": { extension: "png", inline: true },
  "image/jpeg": { extension: "jpg", inline: true },
  "image/webp": { extension: "webp", inline: true },
  "video/mp4": { extension: "mp4", inline: true },
  "application/json": { extension: "json", inline: false },
  "text/plain": { extension: "txt", inline: false },
  "text/html": { extension: "html", inline: false },
} as const;

export type ArtifactMimeType = keyof typeof ARTIFACT_MIME_TYPES;

export function isArtifactMimeType(value: string): value is ArtifactMimeType {
  return Object.hasOwn(ARTIFACT_MIME_TYPES, value);
}

export function extensionFor(mimeType: ArtifactMimeType): string {
  return ARTIFACT_MIME_TYPES[mimeType].extension;
}

export function isInlineRenderable(mimeType: string): boolean {
  return isArtifactMimeType(mimeType) && ARTIFACT_MIME_TYPES[mimeType].inline;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/**
 * Checks that the leading bytes match the declared type. Binary types need a
 * magic number; text types must not look like a binary container. A mismatch
 * is rejected rather than relabelled.
 */
export function contentMatchesMimeType(mimeType: ArtifactMimeType, head: Uint8Array): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8);
    case "video/mp4":
      return startsWith(head, ascii("ftyp"), 4);
    case "application/json":
    case "text/plain":
    case "text/html":
      return !head.subarray(0, 512).includes(0);
  }
}
