// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

const app = await loadPluginApp(() => import("../app.js"));
const panel = app.navPanels[0]!;

const catalogHandlers = {
  "profiles.list": () => ({ profiles: [] }),
  "projects.list": () => ({ projects: [{ id: "proj_1", name: "Example" }] }),
  "skills.list": () => ({
    skills: [
      { name: "research", description: "Research current evidence." },
      { name: "reporting", description: "Prepare decision-facing reports." },
    ],
  }),
  "execution.default": () => ({
    providerId: "pi",
    model: "openai-codex/gpt-5.5",
    reasoningLevel: "medium",
    serviceTier: null,
    permissionMode: "full",
  }),
};

afterEach(cleanup);

describe("Sidekick frontend", () => {
  it("registers one Agents navigation page and no workflow surfaces", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(panel).toMatchObject({ id: "sidekick", title: "Agents", path: "sidekick" });
    expect(app.threadPanelActions).toHaveLength(0);
    expect(app.messageDirectives).toHaveLength(0);
  });

  it("opens with an empty agent list without creating a sample", async () => {
    const slot = renderSlot(panel, { subPath: "" }, { rpc: catalogHandlers as never });
    await slot.findByText("No Sidekick agents yet");
    expect(slot.getByText(/Sidekick does not seed examples\./u)).toBeDefined();
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual([
      "profiles.list",
      "projects.list",
      "skills.list",
      "execution.default",
    ]);
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("uses catalog-backed execution and skill controls without a separate behavior field", async () => {
    const slot = renderSlot(panel, { subPath: "" }, { rpc: catalogHandlers as never });
    fireEvent.click(await slot.findByRole("button", { name: "New agent" }));
    expect(slot.getByRole("dialog")).toBeDefined();
    expect(slot.getByText("New Sidekick agent")).toBeDefined();
    expect(slot.getByText("Agent instructions")).toBeDefined();
    expect(slot.getByText("Provider and model")).toBeDefined();
    expect(slot.getByRole("button", { name: "Choose provider and model" })).toBeDefined();
    expect(slot.getByRole("textbox", { name: "Search skills" })).toBeDefined();
    expect(slot.getByText("research")).toBeDefined();
    fireEvent.click(slot.getByRole("checkbox", { name: /research/u }));
    expect(slot.getByText("Selected 1/12")).toBeDefined();
    expect(slot.queryByText("Behavior defaults")).toBeNull();
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "profiles.create")).toEqual([]);
    slot.lifecycle.unmount();
  });
});
