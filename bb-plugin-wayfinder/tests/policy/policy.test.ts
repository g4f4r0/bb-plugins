import { describe, expect, it } from "vitest";

import { ApprovalRegistry } from "../../src/policy/approvals.js";
import type { WayfinderRoute } from "../../src/contracts/route.js";
import { assertActionAllowed } from "../../src/policy/actions.js";
import { assertAllowedUrl, assertResolvedUrlAllowed } from "../../src/policy/origins.js";
import { sanitizeObservationForProvider } from "../../src/policy/privacy.js";
import { makeRoute } from "../contracts/fixtures.js";

const hash = "a".repeat(64);

describe("execution policy", () => {
  it("rejects forged and replayed approvals", () => {
    const registry = new ApprovalRegistry(() => 100);
    registry.add({ approvalId: "approval_one", runId: "run_one", actionId: "action_one", targetId: "target_one", targetGeneration: "generation_one", userId: "user_one", routePolicyHash: hash, stateHash: hash, issuedAt: 1, expiresAt: 200, singleUse: true });
    expect(() => registry.consume({ approvalId: "approval_one", runId: "run_one", actionId: "action_one", targetId: "target_two", targetGeneration: "generation_one", routePolicyHash: hash, stateHash: hash, userId: "user_one" })).toThrowError();
    registry.consume({ approvalId: "approval_one", runId: "run_one", actionId: "action_one", targetId: "target_one", targetGeneration: "generation_one", routePolicyHash: hash, stateHash: hash, userId: "user_one" });
    expect(() => registry.consume({ approvalId: "approval_one", runId: "run_one", actionId: "action_one", targetId: "target_one", targetGeneration: "generation_one", routePolicyHash: hash, stateHash: hash, userId: "user_one" })).toThrowError();
  });

  it("rejects a stale target snapshot", () => {
    const route: WayfinderRoute = { ...makeRoute(), allowedActions: ["browser.click"] };
    const observation = {
      identity: { adapter: "browser" as const, hostId: "host_test", resourceId: "tab_one", resourceGeneration: "generation_two", snapshotId: "snapshot_two", observedAt: 1 },
      title: "fixture", location: "http://127.0.0.1:4173/", text: "Create", stateHash: hash, changedTargetIds: [], humanActivityDetected: false,
      targets: [{ targetId: "create", resourceGeneration: "generation_two", role: "button", name: "Create", valueSummary: null, bounds: null, allowedOperations: ["click" as const] }],
    };
    expect(() => assertActionAllowed(route, {
      actionId: "action_one", runId: "run_one", routePolicyHash: hash, observation: { ...observation.identity, snapshotId: "snapshot_one" },
      action: { kind: "browser.click", target: { targetId: "create", resourceGeneration: "generation_two", snapshotId: "snapshot_one" } }, intentRecordedAt: 1,
    }, observation)).toThrowError(/changed|stale/iu);
  });

  it("separates navigation and resource origins", () => {
    const route = makeRoute();
    expect(assertAllowedUrl(route, "http://127.0.0.1:4173/done", "navigation").pathname).toBe("/done");
    expect(() => assertAllowedUrl(route, "https://example.com/", "navigation")).toThrowError(/not allowed/iu);
  });

  it("rejects an external hostname that resolves to a private address", async () => {
    const route: WayfinderRoute = {
      ...makeRoute(),
      browser: { ...makeRoute().browser, navigationOrigins: [{ origin: "https://example.test", purpose: "external" }] },
    };
    const resolver = async () => [{ address: "169.254.169.254", family: 4 }] as never;
    await expect(assertResolvedUrlAllowed(route, "https://example.test/", "navigation", resolver)).rejects.toMatchObject({ code: "policy-denied" });
  });

  it("redacts secret-shaped text and sensitive field values before provider calls", () => {
    const sanitized = sanitizeObservationForProvider({
      identity: { adapter: "browser", hostId: "host_test", resourceId: "tab_one", resourceGeneration: "generation_one", snapshotId: "snapshot_one", observedAt: 1 },
      title: "token=topsecret", location: null, text: "password: hunter2", stateHash: hash, changedTargetIds: [], humanActivityDetected: false,
      targets: [{ targetId: "password", resourceGeneration: "generation_one", role: "textbox", name: "Password", valueSummary: "hunter2", bounds: null, allowedOperations: ["type"] }],
    });
    expect(sanitized.text).not.toContain("hunter2");
    expect(sanitized.targets[0]?.valueSummary).toBeNull();
  });
});
