// Pinned toolchain for the plugin-managed Whisper environment. Every value
// here feeds INSTALL_SPEC_ID, so changing one makes existing installs rebuild
// their Python environment on the next start.
import { createHash } from "node:crypto";

export const UV_VERSION = "0.13.0";
export const PYTHON_VERSION = "3.12";

/**
 * Pinned engines, ranged support packages: the newest wheel differs by OS
 * (PyAV resolves to 14.x on macOS 12 and 19.x elsewhere); the server's own
 * decoder works across PyAV 12-19.
 */
export const SERVER_PACKAGES = [
  "onnx-asr[cpu,hub]==0.12.0",
  "av>=12,<20",
  "fastapi>=0.115,<1",
  "uvicorn>=0.30,<1",
  "python-multipart>=0.0.18,<1",
] as const;

/** Whisper's engine (CTranslate2, ~150 MB) is installed only while a Whisper model is selected. */
export const WHISPER_PACKAGES = ["faster-whisper==1.2.1"] as const;

interface UvAsset {
  readonly target: string;
  readonly sha256: string;
  readonly archive: "tar.gz" | "zip";
}

// SHA-256 sums from the uv 0.13.0 release's .sha256 files, checked after download.
const UV_ASSETS: Readonly<Record<string, UvAsset>> = {
  "linux-x64": {
    target: "x86_64-unknown-linux-musl",
    sha256: "b0828fc4cdc47d65951e94b5f0a15a5364420e8dcd88723f3b21e7a2eb30bbc3",
    archive: "tar.gz",
  },
  "linux-arm64": {
    target: "aarch64-unknown-linux-musl",
    sha256: "281ca6cf43f4e26e35474839ad4861be86de42af2682f74134460f5b2071b96d",
    archive: "tar.gz",
  },
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6",
    archive: "tar.gz",
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    sha256: "5f44dcbde809b632f47c36fadb241cb4d6f9af71d0c8f172b5d2026d3dde742c",
    archive: "tar.gz",
  },
  "win32-x64": {
    target: "x86_64-pc-windows-msvc",
    sha256: "088962f9e7b7bd9ea740c04c650b2a21c8928c345bd99ac24350dc924dba656c",
    archive: "zip",
  },
};

export type PlatformSupport =
  | {
      readonly supported: true;
      readonly windows: boolean;
      readonly uv: UvAsset & { readonly url: string };
    }
  | { readonly supported: false; readonly reason: string };

export function platformSupport(platform: NodeJS.Platform, arch: string): PlatformSupport {
  const asset = UV_ASSETS[`${platform}-${arch}`];
  if (asset === undefined) {
    const reason =
      platform === "win32" && arch === "arm64"
        ? "Windows on ARM is not supported: CTranslate2 (used by faster-whisper) ships no wheels for it. Set \"Whisper server URL\" to a server elsewhere"
        : `${platform}-${arch} is not supported; use Linux, macOS or Windows x64, or set "Whisper server URL" to a server elsewhere`;
    return { supported: false, reason };
  }
  return {
    supported: true,
    windows: platform === "win32",
    uv: {
      ...asset,
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${asset.target}.${asset.archive}`,
    },
  };
}

/** Identifies one installed environment; a different id rebuilds it. */
export function installSpecId(whisper: boolean): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        uv: UV_VERSION,
        python: PYTHON_VERSION,
        server: SERVER_PACKAGES,
        whisper: whisper ? WHISPER_PACKAGES : [],
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
