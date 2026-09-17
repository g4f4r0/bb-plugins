import type { Entry } from "./server";

export type Directory = { entries: Entry[]; checkedAt: number; error?: string };
export type TreeRow = {
  key: string;
  depth: number;
  entry?: Entry;
  status?: string;
  error?: boolean;
};

/** Flatten only expanded branches; iterative so deep paths cannot overflow the stack. */
export function treeRows(
  directories: ReadonlyMap<string, Directory>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const stack: Array<
    { path: string; depth: number } | { entry: Entry; depth: number }
  > = [{ path: "", depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if ("entry" in item) {
      rows.push({
        key: item.entry.relativePath,
        depth: item.depth,
        entry: item.entry,
      });
      if (
        item.entry.kind === "directory" &&
        expanded.has(item.entry.relativePath)
      ) {
        stack.push({ path: item.entry.relativePath, depth: item.depth + 1 });
      }
      continue;
    }
    const directory = directories.get(item.path);
    if (!directory) {
      for (let i = 0; i < (item.depth === 0 ? 8 : 4); i++) {
        rows.push({
          key: `${item.path}//loading/${i}/`,
          depth: item.depth,
          status: "Loading",
        });
      }
      continue;
    }
    if (directory.entries.length === 0 || directory.error) {
      rows.push({
        key: `${item.path}/`,
        depth: item.depth,
        status: directory?.error ?? (directory ? "Empty" : "Loading"),
        error: !!directory?.error,
      });
    }
    const entries = directory?.entries ?? [];
    for (let i = entries.length - 1; i >= 0; i--)
      stack.push({ entry: entries[i]!, depth: item.depth });
  }
  return rows;
}

export function visibleRange(
  count: number,
  top: number,
  height: number,
  rowHeight: number,
) {
  const start = Math.max(0, Math.min(count, Math.floor(top / rowHeight) - 8));
  const end = Math.min(
    count,
    Math.max(start, Math.ceil((top + height) / rowHeight) + 8),
  );
  return { start, end };
}

/** Evict oldest collapsed directories. Expanded branches are the working set. */
export function pruneDirectories(
  directories: Map<string, Directory>,
  expanded: ReadonlySet<string>,
) {
  let count = [...directories.values()].reduce(
    (sum, dir) => sum + dir.entries.length,
    0,
  );
  for (const [path, dir] of directories) {
    if (directories.size <= 128 && count <= 50_000) break;
    if (path === "" || expanded.has(path)) continue;
    directories.delete(path);
    count -= dir.entries.length;
  }
}
