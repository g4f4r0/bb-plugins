import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FilesPanel } from "./app";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const root = {
  hostId: "host_test",
  environmentId: "env_test",
  rootPath: "/repo",
};

test("10k root only mounts viewport; keyboard reaches final row", async () => {
  const entries = Array.from({ length: 10_000 }, (_, i) => ({
    name: `f${i}`,
    relativePath: `f${i}`,
    kind: "file",
  }));
  const slot = renderSlot(
    { component: FilesPanel },
    { threadId: "a" },
    { rpc: { workspace_root: () => root, list_dir: () => ({ entries }) } },
  );
  await act(async () => {});
  const tree = slot.container.querySelector("[data-sidetree-tree]")!;
  expect(tree.querySelectorAll("li").length).toBeLessThan(50);
  const first = tree.querySelector("a")!;
  fireEvent.keyDown(first, { key: "End" });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(tree.textContent).toContain("f9999");
  expect(tree.querySelectorAll("li").length).toBeLessThan(50);
});

test("thread switches discard previous tree cache; initial search never claims no matches", async () => {
  const slot = renderSlot(
    { component: FilesPanel },
    { threadId: "a" },
    {
      rpc: {
        workspace_root: () => root,
        list_dir: ({ threadId }: { threadId: string }) => ({
          entries: [{ name: threadId, relativePath: threadId, kind: "file" }],
        }),
        search_files: () => ({ entries: [] }),
      },
    },
  );
  await act(async () => {});
  expect(slot.getByRole("link", { name: "a" })).toBeTruthy();
  slot.rerender(<FilesPanel threadId="b" />);
  await act(async () => {});
  expect(slot.getByRole("link", { name: "b" })).toBeTruthy();
  expect(slot.queryByRole("link", { name: "a" })).toBeNull();
  fireEvent.change(slot.getByLabelText("Search files"), {
    target: { value: "xyz" },
  });
  expect(slot.queryByText("No matching files")).toBeNull();
});

test("workspace retry preserves the scroller and its overflow observer", async () => {
  vi.useFakeTimers();
  let offline = true;
  const slot = renderSlot(
    { component: FilesPanel },
    { threadId: "a" },
    {
      rpc: {
        workspace_root: () => {
          if (offline) throw new Error("offline");
          return root;
        },
        list_dir: () => ({ entries: [] }),
      },
    },
  );
  const scroller = slot.container.querySelector(".h-full.overflow-auto");
  await act(async () => {});
  expect(slot.getByRole("alert").textContent).toBe("offline");
  expect(slot.container.querySelector(".h-full.overflow-auto")).toBe(scroller);
  offline = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10100);
  });
  expect(slot.queryByRole("alert")).toBeNull();
  expect(slot.container.querySelector(".h-full.overflow-auto")).toBe(scroller);
});
