import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";

import hostEntry from "../host.js";

describe("foundation host stub", () => {
  it("validates the contract and refuses to imply a runnable adapter", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    await expect(
      harness.experimental_call("capabilities.probe", { expectedHostId: "host_test" }),
    ).rejects.toThrow("foundation stub");
    await expect(
      harness.experimental_call(
        "capabilities.probe",
        { expectedHostId: "host_test", unknown: true } as never,
      ),
    ).rejects.toThrow();
    await harness.experimental_dispose();
  });
});
