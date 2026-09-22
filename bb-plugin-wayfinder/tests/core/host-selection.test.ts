import { describe, expect, it } from "vitest";
import { isPortableBrowserRoute, orderedHostCandidates } from "../../src/core/host-selection.js";
import { makeRoute } from "../contracts/fixtures.js";
import type { WayfinderRoute } from "../../src/contracts/route.js";

describe("host selection", () => {
  it("keeps filesystem and desktop work on the thread host", () => {
    expect(isPortableBrowserRoute(makeRoute())).toBe(false);
  });

  it("allows explicit browser-only work to use another eligible host", () => {
    const route: WayfinderRoute = {
      ...makeRoute(),
      hostSelection: "any" as const,
      desktop: { applications: [] },
      filesystem: { roots: [] },
      allowedActions: ["browser.navigate", "browser.click"],
    };
    expect(isPortableBrowserRoute(route)).toBe(true);
  });

  it("orders thread, fallback, then stable remaining hosts without duplicates", () => {
    expect(orderedHostCandidates("host_thread", "host_fallback", ["host_z", "host_thread", "host_a"]))
      .toEqual(["host_thread", "host_fallback", "host_a", "host_z"]);
  });
});
