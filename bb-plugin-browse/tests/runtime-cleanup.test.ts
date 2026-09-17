import { describe, expect, it } from "vitest";
import { isOwnedOrphan } from "../src/runtime-cleanup";

const root = "/home/test/.bb/plugins/browse/host-data";

describe("managed runtime cleanup ownership", () => {
  it("matches only parentless Browse processes", () => {
    expect(
      isOwnedOrphan(
        {
          ppid: 1,
          executable: `${root}/browsers/fortress/chrome`,
          command: "chrome",
          environment: "",
        },
        root,
      ),
    ).toBe(true);
    expect(
      isOwnedOrphan(
        {
          ppid: 42,
          executable: `${root}/browsers/fortress/chrome`,
          command: "chrome",
          environment: "",
        },
        root,
      ),
    ).toBe(false);
  });

  it("recognizes an orphaned Browse Selkies process without claiming another instance", () => {
    expect(
      isOwnedOrphan(
        {
          ppid: 1,
          executable: "/usr/bin/python3",
          command: "python3 -m selkies --port 1234 ",
          environment: `PYTHONPATH=${root}/selkies-runtime/opt/selkies`,
        },
        root,
      ),
    ).toBe(true);
    expect(
      isOwnedOrphan(
        {
          ppid: 1,
          executable: "/usr/bin/python3",
          command: "python3 -m selkies --port 1234 ",
          environment: "PYTHONPATH=/opt/another-selkies",
        },
        root,
      ),
    ).toBe(false);
  });
});
