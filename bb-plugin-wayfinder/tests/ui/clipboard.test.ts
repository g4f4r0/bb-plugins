import { describe, expect, it, vi } from "vitest";

import { copyArtifact, type ClipboardEnvironment } from "../../components/clipboard.js";

const LINK = "https://bb.example/api/v1/plugins/wayfinder/http/v1/artifacts/inline?artifactId=art_a&threadId=thr_a";

class FakeClipboardItem {
  static supports?: (type: string) => boolean;
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function env(options: {
  write?: (items: unknown[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
  clipboard?: false;
  ClipboardItem?: false;
  supportsPng?: boolean;
}): ClipboardEnvironment & { writes: unknown[][]; texts: string[] } {
  const writes: unknown[][] = [];
  const texts: string[] = [];
  const Item = class extends FakeClipboardItem {};
  if (options.supportsPng !== undefined) Item.supports = (type) => options.supportsPng === true && type === "image/png";
  return {
    writes,
    texts,
    clipboard:
      options.clipboard === false
        ? undefined
        : {
            write: async (items: ClipboardItems) => {
              writes.push(items as unknown[]);
              // Settle the promised blob the way a real clipboard would.
              await Promise.all((items as unknown as FakeClipboardItem[]).map((item) => Promise.all(Object.values(item.items))));
              await options.write?.(items as unknown[]);
            },
            writeText: async (text: string) => {
              texts.push(text);
              await options.writeText?.(text);
            },
          },
    ClipboardItem: options.ClipboardItem === false ? undefined : (Item as unknown as typeof ClipboardItem),
    toPng: async (blob) => new Blob([await blob.arrayBuffer()], { type: "image/png" }),
  };
}

const png = async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

describe("copyArtifact", () => {
  it("copies the image itself when the browser supports PNG clipboard items", async () => {
    const e = env({ supportsPng: true });
    await expect(copyArtifact({ isImage: true, fetchImage: png, link: LINK, env: e })).resolves.toEqual({ kind: "image" });
    expect(e.writes).toHaveLength(1);
    expect(e.texts).toEqual([]);
  });

  it("converts WebP evidence to PNG before writing", async () => {
    const toPng = vi.fn(async (blob: Blob) => new Blob([await blob.arrayBuffer()], { type: "image/png" }));
    const e = { ...env({ supportsPng: true }), toPng };
    const webp = async () => new Blob([new Uint8Array([9])], { type: "image/webp" });
    await expect(copyArtifact({ isImage: true, fetchImage: webp, link: LINK, env: e })).resolves.toEqual({ kind: "image" });
    expect(toPng).toHaveBeenCalledOnce();
  });

  it("falls back to a labelled private link when image clipboard items are unsupported", async () => {
    const e = env({ supportsPng: false });
    const outcome = await copyArtifact({ isImage: true, fetchImage: png, link: LINK, env: e });
    expect(outcome).toMatchObject({ kind: "link" });
    expect(outcome.kind === "link" && outcome.note).toMatch(/not supported.*private BB link/u);
    expect(e.writes).toEqual([]);
    expect(e.texts).toEqual([LINK]);
  });

  it("falls back to a link when the browser blocks the image write", async () => {
    const e = env({ write: async () => Promise.reject(new DOMException("denied", "NotAllowedError")) });
    const outcome = await copyArtifact({ isImage: true, fetchImage: png, link: LINK, env: e });
    expect(outcome).toMatchObject({ kind: "link" });
    expect(outcome.kind === "link" && outcome.note).toMatch(/blocked image copy/u);
  });

  it("falls back to a link when fetching the image fails", async () => {
    const e = env({});
    const outcome = await copyArtifact({ isImage: true, fetchImage: async () => Promise.reject(new Error("404")), link: LINK, env: e });
    expect(outcome.kind).toBe("link");
    expect(e.texts).toEqual([LINK]);
  });

  it("copies videos and reports as links, never as images", async () => {
    const e = env({ supportsPng: true });
    const fetchImage = vi.fn(png);
    const outcome = await copyArtifact({ isImage: false, fetchImage, link: LINK, env: e });
    expect(outcome.kind).toBe("link");
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("offers manual selection when the Clipboard API is unavailable", async () => {
    const outcome = await copyArtifact({ isImage: true, fetchImage: png, link: LINK, env: env({ clipboard: false }) });
    expect(outcome).toEqual({ kind: "manual", text: LINK, note: expect.stringMatching(/manually/u) });
  });

  it("offers manual selection when clipboard text permission is denied", async () => {
    const e = env({
      ClipboardItem: false,
      writeText: async () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    });
    const outcome = await copyArtifact({ isImage: true, fetchImage: png, link: LINK, env: e });
    expect(outcome).toMatchObject({ kind: "manual", text: LINK });
    expect(outcome.kind === "manual" && outcome.note).toMatch(/denied/u);
  });
});
