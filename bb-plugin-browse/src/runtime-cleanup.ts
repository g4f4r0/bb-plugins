import { promises as fs } from "node:fs";
import { join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type ProcessDetails = {
  ppid: number;
  executable: string;
  command: string;
  environment: string;
};

export function isOwnedOrphan(details: ProcessDetails, root: string) {
  if (details.ppid !== 1) return false;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (details.executable.startsWith(prefix)) return true;
  if (
    details.command.includes(`${prefix}browsers${sep}`) ||
    details.command.includes(`${prefix}profiles${sep}`) ||
    details.command.includes(`${prefix}linux-deps${sep}`)
  )
    return true;
  return (
    details.command.includes(" -m selkies ") &&
    details.environment.includes(`${prefix}selkies-runtime${sep}`)
  );
}

async function processDetails(
  pid: number,
): Promise<ProcessDetails | undefined> {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const [executable, command, environment] = await Promise.all([
      fs.readlink(`/proc/${pid}/exe`).catch(() => ""),
      fs
        .readFile(`/proc/${pid}/cmdline`)
        .then((value) => value.toString().replaceAll("\0", " "))
        .catch(() => ""),
      fs
        .readFile(`/proc/${pid}/environ`)
        .then((value) => value.toString().replaceAll("\0", "\n"))
        .catch(() => ""),
    ]);
    const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(ppid)) return;
    return { ppid, executable, command, environment };
  } catch {
    return;
  }
}

async function stopOwnedOrphans(root: string) {
  if (process.platform !== "linux") return;
  const entries = await fs.readdir("/proc");
  const owned: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const details = await processDetails(pid);
    if (details && isOwnedOrphan(details, root)) owned.push(pid);
  }
  for (const pid of owned)
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  const deadline = Date.now() + 2000;
  while (owned.length && Date.now() < deadline) {
    for (let index = owned.length - 1; index >= 0; index--)
      try {
        process.kill(owned[index], 0);
      } catch {
        owned.splice(index, 1);
      }
    if (owned.length) await sleep(50);
  }
  for (const pid of owned)
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
}

const preparations = new Map<string, Promise<void>>();

export function prepareManagedRuntime(root: string) {
  const previous = preparations.get(root);
  if (previous) return previous;
  const work = (async () => {
    await stopOwnedOrphans(root);
    await fs.rm(join(root, "tmp"), { recursive: true, force: true });
    await fs.mkdir(join(root, "tmp"), { recursive: true, mode: 0o700 });
  })();
  preparations.set(root, work);
  void work.catch(() => {
    if (preparations.get(root) === work) preparations.delete(root);
  });
  return work;
}
