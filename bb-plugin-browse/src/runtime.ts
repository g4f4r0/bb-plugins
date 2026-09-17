import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { runProcess } from "./process";
import manifest from "../runtime/package.json";
import lock from "../runtime/package-lock.json";

const revision = createHash("sha256")
  .update(JSON.stringify(lock))
  .digest("hex")
  .slice(0, 12);

/** Cache-buster for proxied DevTools frontend assets. */
export const devtoolsFrontendRev = `${manifest.dependencies["tilion-fortress"]}-${revision}`;

export function runtimePath(root: string) {
  return join(
    root,
    "runtime",
    `fortress-${manifest.dependencies["tilion-fortress"]}-${revision}`,
  );
}

export async function installed(root: string) {
  try {
    await fs.access(join(runtimePath(root), ".ready"));
    return true;
  } catch {
    return false;
  }
}

const installs = new Map<string, Promise<string>>();
export async function ensureRuntime(root: string, signal: AbortSignal) {
  if (await installed(root)) return runtimePath(root);
  const active = installs.get(root);
  if (active) return active;
  const promise = (async () => {
    const dir = runtimePath(root);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(dir, "package.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    await fs.writeFile(join(dir, "package-lock.json"), JSON.stringify(lock), {
      mode: 0o600,
    });
    await runProcess(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: dir, signal },
    );
    await fs.writeFile(join(dir, ".ready"), revision, { mode: 0o600 });
    return dir;
  })();
  installs.set(root, promise);
  try {
    return await promise;
  } finally {
    installs.delete(root);
  }
}

export async function fortressSdk(root: string, signal: AbortSignal) {
  const dir = await ensureRuntime(root, signal);
  return import(
    pathToFileURL(join(dir, "node_modules/tilion-fortress/index.js")).href
  ) as Promise<any>;
}

async function fortressLocation(root: string, signal: AbortSignal) {
  const sdk = await fortressSdk(root, signal);
  const platform = sdk.resolvePlatform();
  if (!platform || !sdk.ASSETS[platform])
    throw new Error(
      `Fortress has no native browser for ${process.platform}/${process.arch}.`,
    );
  const channel = sdk.CHANNELS.latest;
  const asset = sdk.ASSETS[platform];
  const cache = join(root, "browsers", "fortress");
  return {
    platform,
    channel,
    asset,
    cache,
    executable: join(cache, channel.tag, platform, asset.launcher),
  };
}

export async function fortressExecutable(root: string) {
  if (!(await installed(root))) return;
  const location = await fortressLocation(root, AbortSignal.timeout(15000));
  try {
    await fs.access(location.executable);
    return location.executable;
  } catch {
    return;
  }
}

/** Compatibility alias for opt-in benchmark scripts. */
export const chromeExecutable = fortressExecutable;

async function expectedSha(url: string, asset: string, signal: AbortSignal) {
  const response = await fetch(`${url}/SHA256SUMS`, { signal });
  if (!response.ok)
    throw new Error(`Fortress checksum download failed (${response.status}).`);
  for (const line of (await response.text()).split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name?.replace(/^\*/, "") === asset) return hash.toLowerCase();
  }
  throw new Error("Fortress release did not publish a checksum for this host.");
}

const browserInstalls = new Map<string, Promise<string>>();
export async function installFortress(root: string, signal: AbortSignal) {
  const active = browserInstalls.get(root);
  if (active) return active;
  const promise = installFortressOnce(root, signal);
  browserInstalls.set(root, promise);
  try {
    return await promise;
  } finally {
    if (browserInstalls.get(root) === promise) browserInstalls.delete(root);
  }
}

async function installFortressOnce(root: string, signal: AbortSignal) {
  const location = await fortressLocation(root, signal);
  try {
    await fs.access(location.executable);
    return location.executable;
  } catch {}
  const base = `https://github.com/tiliondev/fortress/releases/download/${location.channel.tag}`;
  const target = join(location.cache, location.channel.tag, location.platform);
  const archive = join(target, location.asset.asset);
  const partial = `${archive}.partial-${process.pid}`;
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  const response = await fetch(`${base}/${location.asset.asset}`, { signal });
  if (!response.ok || !response.body)
    throw new Error(`Fortress download failed (${response.status}).`);
  try {
    await pipeline(
      Readable.fromWeb(response.body as any),
      createWriteStream(partial, { mode: 0o600 }),
      { signal },
    );
    const expected = await expectedSha(base, location.asset.asset, signal);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(partial)) hash.update(chunk);
    const actual = hash.digest("hex");
    if (actual !== expected)
      throw new Error(
        `Fortress checksum mismatch: expected ${expected}, received ${actual}.`,
      );
    await fs.rename(partial, archive);
    if (location.asset.kind === "tar")
      await runProcess("tar", ["xzf", archive, "-C", target], { signal });
    else if (process.platform === "win32")
      await runProcess(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Force -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${target.replaceAll("'", "''")}'`,
        ],
        { signal },
      );
    else throw new Error("Fortress archive format is unsupported on this host.");
    if (process.platform !== "win32") await fs.chmod(location.executable, 0o755);
    await fs.access(location.executable);
    await fs.rm(archive, { force: true });
    return location.executable;
  } finally {
    await fs.rm(partial, { force: true });
  }
}
