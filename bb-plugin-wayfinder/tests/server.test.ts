import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "../server.js";

describe("Wayfinder server integration", () => {
  it("registers bounded RPC, artifact routes, and an agent tool", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wayfinder" });
    await plugin(bb);
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
    expect(harness.inspection.registrations.rpcMethods).toContain("runs.start");
    expect(harness.inspection.registrations.httpRoutes.map((route) => route.path)).toContain("/v1/artifacts/inline");
    expect(harness.inspection.registrations.agentTools.map((tool) => tool.name)).toContain("wayfinder_start");
    expect(harness.inspection.registrations.cli?.name).toBe("wayfinder");
    expect(harness.inspection.registrations.cli?.commands.map((command) => command.name)).toEqual(["doctor", "setup"]);
    await harness.lifecycle.dispose();
  });

  it("imports only public SDK surfaces", async () => {
    const result = await experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname, {
      allow: [/^effect$/u, /^jsdom$/u, /^react$/u, /^@hugeicons\//u, /^sonner$/u, /^@testing-library\//u, /^better-sqlite3$/u],
    });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
