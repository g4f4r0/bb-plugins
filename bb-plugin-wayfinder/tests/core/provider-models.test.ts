import { describe, expect, it, vi } from "vitest";
import { providerModels } from "../../src/core/provider-models.js";

describe("provider model lists", () => {
  it("offers Jev directly without contacting OpenRouter", async () => {
    const fetcher = vi.fn();
    expect(await providerModels("jev", fetcher)).toEqual([{ id: "jev-latest", name: "Jev" }]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses actual OpenRouter models supporting structured outputs", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "vendor/model", name: "Available model", supported_parameters: ["structured_outputs"] },
      { id: "vendor/plain", name: "Plain model", supported_parameters: [] },
      { id: 23, supported_parameters: ["structured_outputs"] },
    ] })));
    expect(await providerModels("openrouter", fetcher)).toEqual([{ id: "vendor/model", name: "Available model" }]);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("does not substitute Jev if OpenRouter is unavailable", async () => {
    await expect(providerModels("openrouter", async () => new Response(null, { status: 503 }))).rejects.toThrow("unavailable");
  });
});
