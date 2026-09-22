import { describe, expect, it } from "vitest";

import { errorMessage } from "../../components/format.js";

describe("errorMessage", () => {
  it("extracts nested RPC errors instead of rendering object coercions", () => {
    expect(errorMessage({ error: { message: "Screen Recording permission is missing" } })).toBe("Screen Recording permission is missing");
    expect(errorMessage({ message: { detail: "Desktop capture failed" } })).toBe("Desktop capture failed");
  });

  it("falls back safely for opaque failures", () => {
    expect(errorMessage({})).toBe("Request failed");
  });
});
