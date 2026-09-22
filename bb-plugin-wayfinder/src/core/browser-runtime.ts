import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

async function executable(path: string): Promise<string | null> {
  try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return path; } catch { return null; }
}

/** Finds an explicitly installed Fortress executable without assuming one server or architecture. */
export async function resolveFortressExecutable(): Promise<string | null> {
  const names = process.platform === "win32" ? ["fortress-browser.exe", "tilion.exe"] : ["fortress-browser", "tilion"];
  const candidates = [
    process.env.WAYFINDER_FORTRESS_PATH,
    ...String(process.env.PATH ?? "").split(delimiter).flatMap((dir) => names.map((name) => join(dir, name))),
    ...(process.platform === "darwin" ? [
      "/Applications/Fortress.app/Contents/MacOS/Fortress",
      join(homedir(), "Applications/Fortress.app/Contents/MacOS/Fortress"),
    ] : []),
  ].filter((path): path is string => Boolean(path));
  for (const candidate of candidates) {
    const found = await executable(candidate);
    if (found) return found;
  }

  // Migration compatibility for users who previously installed Fortress through Browse.
  const legacyRoot = join(homedir(), ".bb", "plugins", "browse", "host-data", "browsers", "fortress");
  try {
    const entries = await readdir(legacyRoot, { recursive: true, withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && (entry.name === "tilion" || entry.name === "tilion.exe"))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
      .reverse();
    for (const candidate of matches) {
      const found = await executable(candidate);
      if (found) return found;
    }
  } catch { /* not installed through Browse */ }
  return null;
}
