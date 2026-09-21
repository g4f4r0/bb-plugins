export type CopyOutcome =
  | { readonly kind: "image" }
  | { readonly kind: "link"; readonly note: string }
  | { readonly kind: "manual"; readonly text: string; readonly note: string };

export interface ClipboardEnvironment {
  readonly clipboard: Pick<Clipboard, "write" | "writeText"> | undefined;
  readonly ClipboardItem: (typeof globalThis)["ClipboardItem"] | undefined;
  /** Converts any browser-decodable image to PNG, the one type clipboards reliably accept. */
  readonly toPng: (blob: Blob) => Promise<Blob>;
}

export function browserClipboardEnvironment(): ClipboardEnvironment {
  return {
    clipboard: typeof navigator === "undefined" ? undefined : navigator.clipboard,
    ClipboardItem: typeof ClipboardItem === "undefined" ? undefined : ClipboardItem,
    toPng: blobToPng,
  };
}

/**
 * Copy order: the image itself (PNG) when this browser supports it, then the
 * private link, then a manual-selection fallback. The outcome always says what
 * was actually copied, so the UI never claims an image copy that didn't happen.
 */
export async function copyArtifact(options: {
  readonly isImage: boolean;
  readonly fetchImage: () => Promise<Blob>;
  readonly link: string;
  readonly env: ClipboardEnvironment;
}): Promise<CopyOutcome> {
  const { env } = options;
  let reason = options.isImage ? "Image copy is not supported in this browser" : "Videos and reports are copied as links";
  if (options.isImage && env.clipboard !== undefined && env.ClipboardItem !== undefined) {
    const supports = (env.ClipboardItem as { supports?: (type: string) => boolean }).supports;
    if (supports === undefined || supports.call(env.ClipboardItem, "image/png")) {
      try {
        // A promised blob keeps the write inside the user gesture (Safari).
        const png = options.fetchImage().then(async (blob) => (blob.type === "image/png" ? blob : env.toPng(blob)));
        await env.clipboard.write([new env.ClipboardItem({ "image/png": png })]);
        return { kind: "image" };
      } catch {
        reason = "The browser blocked image copy";
      }
    }
  }
  if (env.clipboard !== undefined) {
    try {
      await env.clipboard.writeText(options.link);
      return { kind: "link", note: `${reason}; copied a private BB link instead (requires BB sign-in).` };
    } catch {
      reason = "Clipboard access was denied";
    }
  }
  return { kind: "manual", text: options.link, note: `${reason}. Select the link below and copy it manually.` };
}

async function blobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas unavailable");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png === null ? reject(new Error("PNG conversion failed")) : resolve(png)), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}
