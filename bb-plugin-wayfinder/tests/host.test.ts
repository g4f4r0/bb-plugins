import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";

import hostEntry from "../host.js";

describe("Wayfinder host integration", () => {
  it("probes capabilities and validates strict input", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);
    const result = await harness.experimental_call("capabilities.probe", { expectedHostId: "host_test" });
    expect(result.hostId).toBe("host_test");
    expect(result.decisionProvider.state).toBe("setup-required");
    await expect(
      harness.experimental_call(
        "capabilities.probe",
        { expectedHostId: "host_test", unknown: true } as never,
      ),
    ).rejects.toThrow();
    await harness.experimental_dispose();
  });
});
