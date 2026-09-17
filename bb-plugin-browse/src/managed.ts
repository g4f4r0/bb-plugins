import { existsSync, promises as fs } from "node:fs";
import { join, delimiter } from "node:path";
import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { runProcess } from "./process";
import { configureProfilePreferences } from "./profile-preferences";
import { spawnWatched } from "./watched-process";
import {
  installed,
  fortressExecutable,
  installFortress,
} from "./runtime";

export function managedEnv(root: string) {
  const env = { ...process.env };
  for (const k of Object.keys(env))
    if (k.startsWith("AGENT_BROWSER_") || k.startsWith("AI_GATEWAY_"))
      delete env[k];
  const libs = join(root, "linux-deps", "root");
  const arch =
    process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  env.LD_LIBRARY_PATH = [
    join(libs, "usr/lib", arch),
    join(libs, "lib", arch),
    join(libs, "usr/lib", arch, "pulseaudio"),
    join(libs, "usr/lib", arch, "blas"),
    join(libs, "usr/lib", arch, "lapack"),
    env.LD_LIBRARY_PATH,
  ]
    .filter(Boolean)
    .join(delimiter);
  env.PATH = [join(libs, "usr/bin"), env.PATH].filter(Boolean).join(delimiter);
  env.XKB_CONFIG_ROOT = join(libs, "usr/share/X11/xkb");
  return env;
}
export function videoChromeArgs(profile: string, initialUrl: string) {
  return [
    ...chromeArgs(profile, initialUrl).filter((arg) => arg !== initialUrl),
    "--test-type",
    "--disable-infobars",
    "--window-position=0,0",
    `--app=${initialUrl}`,
  ];
}
export async function diagnostics(root: string) {
  const runtime = await installed(root);
  let browserPath: string | undefined,
    browserVersion: string | undefined,
    launchError: string | undefined;
  const env = managedEnv(root);
  if (runtime) {
    browserPath = await fortressExecutable(root);
    if (browserPath)
      try {
        await fs.access(browserPath);
        browserVersion = await runProcess(browserPath, ["--version"], {
          env,
          signal: AbortSignal.timeout(10000),
        });
      } catch (e) {
        launchError = String(e);
        browserPath = undefined;
      }
  }
  const ffmpeg = await runProcess("ffmpeg", ["-version"], {
    env,
    signal: AbortSignal.timeout(5000),
  }).then(
    () => true,
    () => false,
  );
  const display = displayFiles(root, env);
  return {
    platform: process.platform,
    arch: process.arch,
    runtime,
    browserInstalled: !!browserPath,
    browserRunnable: !!browserVersion,
    browserPath: browserPath ?? null,
    browserVersion: browserVersion ?? null,
    launchError: launchError ?? null,
    ffmpeg,
    ...display,
  };
}
export const LINUX_DEP_PACKAGES = [
  "libnss3",
  "libatk-bridge2.0-0",
  "libasound2",
  "libgbm1",
  "libcups2",
  "libpango-1.0-0",
  "libcairo2",
  "libxcomposite1",
  "libxdamage1",
  "libxrandr2",
  "libxkbcommon0",
  "fonts-liberation",
  "ffmpeg",
  "xvfb",
  "x11-xkb-utils",
  "xkb-data",
] as const;
function displayFiles(root: string, env = managedEnv(root)) {
  if (process.platform !== "linux")
    return {
      display: "host" as const,
      xvfb: true,
      xkbcomp: true,
      xkbData: true,
    };
  const libs = join(root, "linux-deps", "root");
  const xvfb = !!findOnPath(env, "Xvfb");
  const xkbcomp =
    existsSync("/usr/bin/xkbcomp") || existsSync(join(libs, "usr/bin/xkbcomp"));
  const xkbData =
    existsSync("/usr/share/X11/xkb/symbols") ||
    existsSync(join(libs, "usr/share/X11/xkb/symbols"));
  return {
    display: process.env.DISPLAY
      ? ("host" as const)
      : xvfb && xkbcomp && xkbData
        ? ("virtual" as const)
        : ("missing" as const),
    xvfb,
    xkbcomp,
    xkbData,
  };
}
let install: Promise<void> | undefined;
export async function installManaged(
  root: string,
  dependencies: boolean,
  signal: AbortSignal,
) {
  if (install) return install;
  if (activeProfiles.size)
    throw new Error(
      "Close managed browsers and wait for dependency checks before updating dependencies.",
    );
  install = (async () => {
    await installFortress(root, signal);
    if (dependencies && process.platform === "linux") {
      const dir = join(root, "linux-deps"),
        archives = join(dir, "archives"),
        target = join(dir, "root");
      await fs.mkdir(join(archives, "partial"), { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await runProcess(
        "apt-get",
        [
          "--download-only",
          "--yes",
          "--reinstall",
          "--no-install-recommends",
          "-o",
          "Debug::NoLocking=1",
          "-o",
          `Dir::Cache::archives=${archives}`,
          "install",
          ...LINUX_DEP_PACKAGES,
        ],
        { signal, limit: 1000000 },
      );
      for (const name of await fs.readdir(archives))
        if (name.endsWith(".deb"))
          await runProcess("dpkg-deb", ["-x", join(archives, name), target], {
            signal,
          });
    }
  })();
  try {
    await install;
  } finally {
    install = undefined;
  }
}
export function chromeArgs(profile: string, initialUrl = "about:blank") {
  return [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--window-size=1280,800",
    ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    initialUrl,
  ];
}
export function xvfbArgs(display: number) {
  return [
    `:${display}`,
    "-screen",
    "0",
    "1280x800x24",
    "-nolisten",
    "tcp",
    "-ac",
  ];
}
const XVFB_WRAP = `set -eu
ovl="\${TMPDIR:-/tmp}/browse-xvfb-$$"
mkdir -p "$ovl/upper" "$ovl/work"
mount -t overlay overlay -o "lowerdir=/usr/bin,upperdir=$ovl/upper,workdir=$ovl/work" /usr/bin
cp -f "$BROWSE_XKBCOMP" /usr/bin/xkbcomp
chmod +x /usr/bin/xkbcomp
if [ -n "\${BROWSE_XKBDATA:-}" ] && [ ! -e /usr/share/X11/xkb/symbols ]; then
  mkdir -p "$ovl/x11u" "$ovl/x11w"
  mount -t overlay overlay -o "lowerdir=/usr/share/X11,upperdir=$ovl/x11u,workdir=$ovl/x11w" /usr/share/X11
  mkdir -p /usr/share/X11/xkb
  cp -a "$BROWSE_XKBDATA/." /usr/share/X11/xkb/
fi
exec "$BROWSE_XVFB" "$BROWSE_DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac
`;
export function xvfbLaunch(
  binary: string,
  display: number,
  env: NodeJS.ProcessEnv,
  root: string,
) {
  const args = xvfbArgs(display);
  const libs = join(root, "linux-deps", "root");
  const xkbcomp = join(libs, "usr/bin/xkbcomp");
  const xkbdata = join(libs, "usr/share/X11/xkb");
  const unshare =
    findOnPath(env, "unshare") ||
    findOnPath(process.env, "unshare") ||
    (existsSync("/usr/bin/unshare") ? "/usr/bin/unshare" : undefined);
  if (!existsSync("/usr/bin/xkbcomp") && existsSync(xkbcomp) && unshare)
    return {
      command: unshare,
      args: ["-rm", "--", "/bin/sh", "-c", XVFB_WRAP],
      env: {
        ...env,
        BROWSE_XVFB: binary,
        BROWSE_XKBCOMP: xkbcomp,
        BROWSE_XKBDATA: existsSync(join(xkbdata, "symbols")) ? xkbdata : "",
        BROWSE_DISPLAY: `:${display}`,
      },
    };
  return { command: binary, args, env };
}
function findOnPath(env: NodeJS.ProcessEnv, name: string) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
}
const reservedDisplays = new Set<number>();
let xvfb: { n: number; child: ChildProcess; users: number } | undefined;
export async function acquireDisplay(
  root: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  isolated = false,
): Promise<{ env: NodeJS.ProcessEnv; release: () => Promise<void> }> {
  // macOS and Windows use their native desktop session, not X11/Xvfb.
  if (platform !== "linux") return { env, release: async () => {} };
  if (!isolated && process.env.DISPLAY)
    return {
      env: { ...env, DISPLAY: process.env.DISPLAY },
      release: async () => {},
    };
  if (!isolated && xvfb) {
    xvfb.users++;
    return {
      env: { ...env, DISPLAY: `:${xvfb.n}` },
      release: releaseDisplay,
    };
  }
  const binary = findOnPath(env, "Xvfb");
  if (!binary)
    throw new Error(
      "Headed Chrome needs a display. On this Linux host install Xvfb via Browse Settings, then retry.",
    );
  let n = 90;
  while (
    n < 120 &&
    (reservedDisplays.has(n) ||
      existsSync(`/tmp/.X${n}-lock`) ||
      existsSync(`/tmp/.X11-unix/X${n}`))
  )
    n++;
  const files = displayFiles(root, env);
  if (!files.xvfb)
    throw new Error(
      "Headed Chrome needs Xvfb on this Linux host. Install dependencies in Browse Settings, then retry.",
    );
  if (!files.xkbcomp)
    throw new Error(
      "Headed Chrome needs xkbcomp (x11-xkb-utils). Install dependencies in Browse Settings, then retry.",
    );
  if (!files.xkbData)
    throw new Error(
      "Headed Chrome needs XKB keymap data (xkb-data). Install dependencies in Browse Settings, then retry.",
    );
  if (
    !existsSync("/usr/bin/xkbcomp") &&
    !findOnPath(env, "unshare") &&
    !existsSync("/usr/bin/unshare")
  )
    throw new Error(
      "Headed Chrome needs unshare (util-linux) to provide xkbcomp without root.",
    );
  if (n >= 120) throw Error("No private browser displays are available.");
  const launch = xvfbLaunch(binary, n, env, root);
  reservedDisplays.add(n);
  let child: ChildProcess;
  try {
    child = spawnWatched(launch.command, launch.args, {
      env: launch.env,
      stderr: "pipe",
    });
  } catch (error) {
    reservedDisplays.delete(n);
    throw error;
  }
  let stderr = "";
  child.stderr?.on(
    "data",
    (b) => (stderr = (stderr + b.toString()).slice(-4000)),
  );
  child.once("exit", () => reservedDisplays.delete(n));
  child.once("error", () => reservedDisplays.delete(n));
  const deadline = Date.now() + 8000;
  try {
    while (!existsSync(`/tmp/.X11-unix/X${n}`)) {
      signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error("Xvfb exited: " + stderr);
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error("Xvfb startup timed out: " + stderr);
      }
      await sleep(50, undefined, { signal });
    }
  } catch (error) {
    child.kill("SIGKILL");
    reservedDisplays.delete(n);
    throw error;
  }
  if (isolated) {
    let released = false;
    return {
      env: { ...env, DISPLAY: `:${n}` },
      release: async () => {
        if (released) return;
        released = true;
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          sleep(1000),
        ]);
        if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      },
    };
  }
  xvfb = { n, child, users: 1 };
  child.once("exit", () => {
    if (xvfb?.child === child) xvfb = undefined;
  });
  return {
    env: { ...env, DISPLAY: `:${n}` },
    release: releaseDisplay,
  };
}
async function releaseDisplay() {
  if (!xvfb) return;
  xvfb.users--;
  if (xvfb.users > 0) return;
  const child = xvfb.child;
  xvfb = undefined;
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((r) => child.once("exit", () => r())),
    sleep(1500),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}
export type ManagedBrowser = {
  process: ChildProcess;
  endpoint: string;
  profile: string;
  displayEnv?: NodeJS.ProcessEnv;
  close: () => Promise<void>;
};
const activeProfiles = new Set<string>();
export async function launchManaged(
  root: string,
  profileId: string,
  signal: AbortSignal,
  video = false,
  initialUrl = "about:blank",
): Promise<ManagedBrowser> {
  signal.throwIfAborted();
  // Unavailable video hosts keep the ordinary browser and JPEG viewer.
  video = video && process.platform === "linux" && existsSync(join(root, "selkies-runtime/opt/selkies/lib/python3.13/site-packages/selkies"));
  if (install)
    throw new Error(
      "Browser installation is in progress. Wait for its setup job.",
    );
  if (!/^ab-[a-z0-9-]+$/.test(profileId)) throw new Error("Invalid profile ID");
  const key = join(root, "profiles", profileId);
  if (activeProfiles.has(key))
    throw new Error("This browser profile is already running or connecting.");
  activeProfiles.add(key);
  try {
    const browser = await launchBrowser(root, profileId, signal, video, initialUrl);
    const stop = browser.close;
    let closing: Promise<void> | undefined;
    browser.process.once("exit", () => activeProfiles.delete(key));
    browser.close = () =>
      (closing ??= (async () => {
        try {
          await stop();
        } finally {
          activeProfiles.delete(key);
        }
      })());
    return browser;
  } catch (e) {
    activeProfiles.delete(key);
    await fs.rm(join(root, "tmp", profileId), { recursive: true, force: true });
    throw e;
  }
}
async function launchBrowser(
  root: string,
  profileId: string,
  signal: AbortSignal,
  video = false,
  initialUrl = "about:blank",
): Promise<ManagedBrowser> {
  const browserPath = await fortressExecutable(root);
  if (!browserPath || !existsSync(browserPath))
    throw new Error(
      "Fortress is not installed on this thread host. Open Browse Settings and install the browser/dependencies.",
    );
  if (!/^ab-[a-z0-9-]+$/.test(profileId)) throw new Error("Invalid profile ID");
  const profile = join(root, "profiles", profileId);
  const sessionTemp = join(root, "tmp", profileId);
  const displayTemp = join(root, "tmp", "display");
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.rm(sessionTemp, { recursive: true, force: true });
  await fs.mkdir(sessionTemp, { recursive: true, mode: 0o700 });
  await fs.mkdir(displayTemp, { recursive: true, mode: 0o700 });
  await configureProfilePreferences(profile);
  await fs.rm(join(profile, "DevToolsActivePort"), { force: true });
  const display = await acquireDisplay(
    root,
    { ...managedEnv(root), TMPDIR: displayTemp },
    signal,
    process.platform,
    video,
  );
  const browserEnv = { ...display.env, TMPDIR: sessionTemp };
  const child = spawnWatched(
    browserPath,
    video ? videoChromeArgs(profile, initialUrl) : chromeArgs(profile, initialUrl),
    {
      env: browserEnv,
      stderr: "pipe",
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr?.on(
    "data",
    (b) => (stderr = (stderr + b.toString()).slice(-8000)),
  );
  let spawnError: Error | undefined;
  child.on("error", (e) => (spawnError = e));
  let released = false;
  const close = async () => {
    try {
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((r) => child.once("exit", () => r())),
          sleep(2000),
        ]);
        if (child.exitCode === null && !child.signalCode) {
          child.kill("SIGKILL");
          await Promise.race([
            new Promise<void>((r) => child.once("exit", () => r())),
            sleep(2000),
          ]);
        }
      }
    } finally {
      if (!released) {
        released = true;
        await display.release();
        await fs.rm(sessionTemp, { recursive: true, force: true });
      }
    }
  };
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error("Fortress exited: " + stderr);
      try {
        const [port, path] = (
          await fs.readFile(join(profile, "DevToolsActivePort"), "utf8")
        )
          .trim()
          .split("\n");
        if (/^\d+$/.test(port) && path.startsWith("/devtools/browser/")) {
          child.once("exit", () => {
            void close();
          });
          return {
            process: child,
            displayEnv: video ? browserEnv : undefined,
            endpoint: `ws://127.0.0.1:${port}${path}`,
            profile,
            close,
          };
        }
      } catch {}
      if (Date.now() > deadline)
        throw new Error("Fortress startup timed out: " + stderr);
      await sleep(80, undefined, { signal });
    }
  } catch (e) {
    await close();
    throw e;
  }
}
