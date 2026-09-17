// @vitest-environment node
import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
const target = {
  path: "a.txt",
  kind: "workspace",
  environmentId: "env_test",
  threadId: null,
};
const file = {
  path: "/repo/a.txt",
  content: "abc",
  contentEncoding: "utf8",
  sizeBytes: 3,
  sha256: "abc",
};

test("poll omits unchanged content and read concurrency is deduplicated", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "sidetree",
    sdk: {
      environments: {
        get: async () => ({
          id: "env_test",
          hostId: "host_test",
          path: "/repo",
        }),
      },
      files: {
        read: async () => {
          await gate;
          return file;
        },
      },
    },
  });
  await plugin(bb);
  const first = harness.behavior.callRpc("read_file", target);
  const second = harness.behavior.callRpc("poll_file", {
    ...target,
    sha256: "abc",
  });
  release();
  const [loaded, polled] = await Promise.all([first, second]);
  expect(loaded.content).toBe("abc");
  expect(polled).toBeNull();
  expect(harness.inspection.sdk.callsTo("files.read")).toHaveLength(1);
  await harness.behavior.callRpc("read_file", target);
  expect(harness.inspection.sdk.callsTo("files.read")).toHaveLength(2);
  await harness.lifecycle.dispose();
});
