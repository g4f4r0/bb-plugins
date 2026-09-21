import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin, { FOUNDATION_ONLY_MESSAGE } from "../server.js";

describe("foundation server stub", () => {
  it("advertises setup-required and registers no runnable surface", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder" });
    await plugin(bb);
    expect(harness.inspection.needsConfigurationMessages).toEqual([FOUNDATION_ONLY_MESSAGE]);
    expect(harness.inspection.registrations.rpcMethods).toEqual([]);
    expect(harness.inspection.registrations.httpRoutes).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("imports only public SDK surfaces", async () => {
    const result = await experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname, {
      allow: [/^effect$/u, /^jsdom$/u],
    });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
