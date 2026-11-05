import { describe, expect, it } from "vitest";
import { platformSupport } from "../src/platform.js";

describe("platformSupport", () => {
  it.each([
    ["linux", "x64", "tar.gz"],
    ["linux", "arm64", "tar.gz"],
    ["darwin", "arm64", "tar.gz"],
    ["darwin", "x64", "tar.gz"],
    ["win32", "x64", "zip"],
  ] as const)("supports %s-%s", (platform, arch, archive) => {
    const support = platformSupport(platform, arch);
    expect(support.supported).toBe(true);
    if (support.supported) {
      expect(support.uv.archive).toBe(archive);
      expect(support.uv.url).toMatch(new RegExp(`/uv-${support.uv.target}\\.${archive.replace(".", "\\.")}$`));
      expect(support.windows).toBe(platform === "win32");
    }
  });

  it("explains Windows on ARM", () => {
    const support = platformSupport("win32", "arm64");
    expect(support.supported).toBe(false);
    if (!support.supported) expect(support.reason).toMatch(/CTranslate2/);
  });
});
