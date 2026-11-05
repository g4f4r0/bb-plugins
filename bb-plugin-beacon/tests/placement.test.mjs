import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlacement, footerKey, planPlacement, railKey } from "../lib/placement.ts";

const FOOTER = footerKey("beacon");
const RAIL = railKey("beacon");
const empty = { hiddenFooterItems: [], pluginPanelOrder: [], visiblePluginPanels: null };

test("keys match bb's footer and rail item ids", () => {
  assert.equal(FOOTER, "plugin:beacon/status");
  assert.equal(RAIL, "beacon/status");
});

test("footer placement on default preferences hides only the rail entry", () => {
  assert.deepEqual(planPlacement(empty, "footer", "beacon"), { pluginPanelOrder: [RAIL], visiblePluginPanels: [] });
});

test("footer placement keeps every other ordered destination visible", () => {
  const current = { hiddenFooterItems: [FOOTER, "plugin:other/x"], pluginPanelOrder: ["__bb__/extensions", "__bb__/search-threads", "notes/notes", RAIL], visiblePluginPanels: null };
  assert.deepEqual(planPlacement(current, "footer", "beacon"), {
    hiddenFooterItems: ["plugin:other/x"],
    visiblePluginPanels: ["__bb__/extensions", "notes/notes"],
  });
});

test("rail placement hides the footer item and shows the rail entry", () => {
  const current = { hiddenFooterItems: ["plugin:other/x"], pluginPanelOrder: ["notes/notes", RAIL], visiblePluginPanels: ["notes/notes"] };
  assert.deepEqual(planPlacement(current, "rail", "beacon"), {
    hiddenFooterItems: ["plugin:other/x", FOOTER],
    visiblePluginPanels: ["notes/notes", RAIL],
  });
});

test("rail placement leaves null visibility alone", () => {
  assert.deepEqual(planPlacement(empty, "rail", "beacon"), { hiddenFooterItems: [FOOTER] });
});

test("a placement that already holds changes nothing", () => {
  const railState = { hiddenFooterItems: [FOOTER], pluginPanelOrder: [], visiblePluginPanels: null };
  assert.deepEqual(planPlacement(railState, "rail", "beacon"), {});
  const footerState = { hiddenFooterItems: [], pluginPanelOrder: [RAIL], visiblePluginPanels: [] };
  assert.deepEqual(planPlacement(footerState, "footer", "beacon"), {});
});

function fakeHost(preferences) {
  const state = Object.fromEntries(Object.entries(preferences).map(([key, value]) => [key, { revision: 0, value }]));
  const writes = [];
  const kv = new Map();
  let conflicts = 0;
  return {
    writes,
    state,
    failNext() { conflicts++; },
    ui: {
      async list() { return { preferences: structuredClone(state) }; },
      async set({ key, value, expectedRevision }) {
        if (conflicts > 0) { conflicts--; state[key].revision++; throw new Error("revision conflict"); }
        assert.equal(expectedRevision, state[key].revision);
        state[key] = { revision: expectedRevision + 1, value };
        writes.push(key);
      },
    },
    store: { async get(key) { return kv.get(key); }, async set(key, value) { kv.set(key, value); } },
  };
}

const prefs = () => ({ "sidebar.hiddenFooterItems": [], "sidebar.pluginPanelOrder": [], "sidebar.visiblePluginPanels": null });

test("applyPlacement writes order before visibility and only once per placement", async () => {
  const host = fakeHost(prefs());
  assert.equal(await applyPlacement(host.ui, host.store, "footer", "beacon"), true);
  assert.deepEqual(host.writes, ["sidebar.pluginPanelOrder", "sidebar.visiblePluginPanels"]);
  assert.equal(await applyPlacement(host.ui, host.store, "footer", "beacon"), false);
  assert.equal(host.writes.length, 2);
  assert.equal(await applyPlacement(host.ui, host.store, "rail", "beacon"), true);
  assert.deepEqual(host.state["sidebar.hiddenFooterItems"].value, [FOOTER]);
  assert.deepEqual(host.state["sidebar.visiblePluginPanels"].value, [RAIL]);
});

test("applyPlacement retries once after a concurrent write", async () => {
  const host = fakeHost(prefs());
  host.failNext();
  assert.equal(await applyPlacement(host.ui, host.store, "rail", "beacon"), true);
  assert.deepEqual(host.state["sidebar.hiddenFooterItems"].value, [FOOTER]);
});
