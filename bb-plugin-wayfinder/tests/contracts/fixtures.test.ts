import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { adapterObservationSchema } from "../../src/contracts/adapter.js";

describe("synthetic fixtures", () => {
  it("exposes a deterministic browser form without external effects", async () => {
    const path = fileURLToPath(new URL("../../fixtures/browser/index.html", import.meta.url));
    const source = await readFile(path, "utf8");
    const dom = new JSDOM(source, {
      runScripts: "dangerously",
      url: "http://127.0.0.1:4173/",
    });
    const input = dom.window.document.querySelector<HTMLInputElement>("#fixture-name");
    const form = dom.window.document.querySelector<HTMLFormElement>("#fixture-form");
    input!.value = "Case 001";
    form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(dom.window.document.querySelector("#fixture-status")?.textContent).toBe(
      "Local report ready for Case 001",
    );
    expect(dom.window.location.pathname).toBe("/done");
    dom.window.close();
  });

  it("keeps the desktop fixture inside the observation contract", async () => {
    const path = fileURLToPath(new URL("../../fixtures/desktop/accessibility.json", import.meta.url));
    const fixture = JSON.parse(await readFile(path, "utf8"));
    expect(adapterObservationSchema.parse(fixture).targets).toHaveLength(2);
  });
});
