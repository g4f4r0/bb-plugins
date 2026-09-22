import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url);

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as Record<string, unknown>;
}

describe("Sidekick package and repository manifest", () => {
  it("uses Sidekick identity consistently and retains MIT attribution", async () => {
    const pkg = await json("package.json");
    expect(pkg.name).toBe("bb-plugin-sidekick");
    expect(pkg.license).toBe("MIT");
    expect(pkg.author).toMatchObject({ name: "Dmitrii Kapustin" });
    expect(pkg.bb).toMatchObject({
      name: "Sidekick",
      server: "./server.ts",
      app: "./app.tsx",
      skills: ["skills"],
    });
    expect(pkg.engines).toMatchObject({ bb: ">=0.43", bbPluginSdk: ">=0.4.87" });
    const license = await readFile(new URL("LICENSE", root), "utf8");
    expect(license).toContain("Copyright (c) 2026 Dmitrii Kapustin");
    const skill = await readFile(new URL("skills/sidekick/SKILL.md", root), "utf8");
    expect(skill).toContain("name: sidekick");
    expect(skill).toContain("bb sidekick spawn");
    expect(skill).not.toContain("bb role");
  });

  it("is present once in the repository plugin manifest", async () => {
    const repositoryManifest = JSON.parse(await readFile(new URL("../.bb/plugins.json", root), "utf8")) as {
      plugins: Array<{ name: string; source: string }>;
    };
    expect(repositoryManifest.plugins.filter((entry) => entry.name === "sidekick")).toEqual([
      { name: "sidekick", source: "./bb-plugin-sidekick" },
    ]);
  });
});
