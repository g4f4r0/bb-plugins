import assert from "node:assert/strict";
import test from "node:test";
import { treeRows, visibleRange, pruneDirectories } from "./tree-model.ts";

test("10k file directory renders only viewport plus overscan", () => {
  const entries = Array.from({ length: 10_000 }, (_, i) => ({
    name: `file-${i}`,
    relativePath: `file-${i}`,
    kind: "file" as const,
  }));
  const rows = treeRows(
    new Map([["", { entries, checkedAt: 0 }]]),
    new Set([""]),
  );
  assert.equal(rows.length, 10_000);
  const range = visibleRange(rows.length, 140_000, 700, 28);
  assert.equal(range.end - range.start, 41);
  assert.equal(rows[range.start].key, "file-4992");
});

test("flatten visits expanded branches and exposes loading, empty and errors", () => {
  const dirs = new Map([
    [
      "",
      {
        entries: [{ name: "a", relativePath: "a", kind: "directory" as const }],
        checkedAt: 0,
      },
    ],
  ]);
  assert.equal(treeRows(dirs, new Set()).length, 1);
  assert.equal(treeRows(dirs, new Set(["a"]))[1].status, "Loading");
  dirs.set("a", { entries: [], checkedAt: 0 });
  assert.equal(treeRows(dirs, new Set(["a"]))[1].status, "Empty");
});

test("directory cache evicts collapsed entries while retaining expanded working set", () => {
  const dirs = new Map(
    Array.from(
      { length: 200 },
      (_, i) => [`d${i}`, { entries: [], checkedAt: 0 }] as const,
    ),
  );
  pruneDirectories(dirs, new Set(["d0"]));
  assert.equal(dirs.size, 128);
  assert.ok(dirs.has("d0"));
});
