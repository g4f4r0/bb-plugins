import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ScopedFilesystem, defaultDataResolver } from "../../src/fs/scoped-filesystem.js";

describe("ScopedFilesystem", () => {
  it("reads and verifies only normalized files inside a declared root", async () => {
    const root = await mkdtemp(join(tmpdir(), "wayfinder-fs-"));
    await mkdir(join(root, "reports"));
    await writeFile(join(root, "reports", "result.txt"), "synthetic ok", { mode: 0o600 });
    const filesystem = new ScopedFilesystem([{ rootId: "root_one", kind: "fixture", absolutePath: root, access: "read-verify" }]);
    const value = await filesystem.read("root_one", "reports/result.txt", new AbortController().signal);
    expect(value.toString()).toBe("synthetic ok");
    const result = await filesystem.verify({ checkpointId: "file_one", kind: "filesystem", timing: "final", rootId: "root_one", relativePath: "reports/result.txt", assertion: { kind: "content", expected: { kind: "synthetic-literal", value: "ok" }, comparison: "contains" } }, defaultDataResolver, new AbortController().signal);
    expect(result.outcome).toBe("pass");
  });

  it("rejects traversal and a symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "wayfinder-fs-"));
    const outside = await mkdtemp(join(tmpdir(), "wayfinder-outside-"));
    await writeFile(join(outside, "secret.txt"), "not in scope");
    await symlink(outside, join(root, "escape"));
    const filesystem = new ScopedFilesystem([{ rootId: "root_one", kind: "fixture", absolutePath: root, access: "read-verify" }]);
    await expect(filesystem.read("root_one", "../secret.txt", new AbortController().signal)).rejects.toBeTruthy();
    await expect(filesystem.read("root_one", "escape/secret.txt", new AbortController().signal)).rejects.toMatchObject({ code: "policy-denied" });
  });
});
