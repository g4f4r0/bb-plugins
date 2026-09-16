import { describe, expect, it } from "vitest";
import {
  MIN_BROWSER_AVAILABLE_BYTES,
  assertBrowserMemory,
  availableMemoryBytes,
} from "../src/memory-budget";

describe("managed browser memory budget", () => {
  it("reads Linux MemAvailable", () => {
    expect(availableMemoryBytes("MemTotal: 100 kB\nMemAvailable: 2048 kB\n")).toBe(
      2048 * 1024,
    );
  });

  it("rejects launches that would risk host-wide eviction", () => {
    expect(() =>
      assertBrowserMemory(
        `MemAvailable: ${Math.floor(MIN_BROWSER_AVAILABLE_BYTES / 1024) - 1} kB`,
      ),
    ).toThrow("Close an idle browser session");
  });

  it("permits launches with the memory cushion intact", () => {
    expect(() =>
      assertBrowserMemory(
        `MemAvailable: ${Math.ceil(MIN_BROWSER_AVAILABLE_BYTES / 1024)} kB`,
      ),
    ).not.toThrow();
  });
});
