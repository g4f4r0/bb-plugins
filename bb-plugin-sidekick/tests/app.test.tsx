// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

const app = await loadPluginApp(() => import("../app.js"));
const panel = app.navPanels[0]!;

afterEach(cleanup);

describe("Sidekick frontend", () => {
  it("registers one Profiles navigation page and no workflow surfaces", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(panel).toMatchObject({ id: "sidekick", title: "Profiles", path: "sidekick" });
    expect(app.threadPanelActions).toHaveLength(0);
    expect(app.messageDirectives).toHaveLength(0);
  });

  it("opens with an empty profile list without creating a sample", async () => {
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        "profiles.list": () => ({ profiles: [] }),
        "projects.list": () => ({ projects: [{ id: "proj_1", name: "Example" }] }),
      } as never,
    });
    await slot.findByText("No Sidekick profiles yet");
    expect(slot.getByText(/Sidekick does not seed examples\./u)).toBeDefined();
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["profiles.list", "projects.list"]);
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("opens the first-profile editor without persisting anything", async () => {
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        "profiles.list": () => ({ profiles: [] }),
        "projects.list": () => ({ projects: [] }),
      } as never,
    });
    fireEvent.click(await slot.findByRole("button", { name: "New profile" }));
    expect(slot.getByRole("dialog")).toBeDefined();
    expect(slot.getByText("New Sidekick profile")).toBeDefined();
    expect(slot.getByText("Profile instructions")).toBeDefined();
    expect(slot.getByText("Behavior defaults")).toBeDefined();
    expect(slot.getByText("Preferred skills")).toBeDefined();
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "profiles.create")).toEqual([]);
    slot.lifecycle.unmount();
  });
});
