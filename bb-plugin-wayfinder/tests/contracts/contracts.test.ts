import { describe, expect, it } from "vitest";

import {
  actionIntentSchema,
  approvalGrantSchema,
  artifactRangeSchema,
  createArtifactShareInputSchema,
  decisionResponseSchema,
  routeSchema,
} from "../../src/contracts/index.js";
import { makeRoute } from "./fixtures.js";

const hash = "a".repeat(64);

describe("route contract", () => {
  it("accepts a bounded fixture route", () => {
    expect(routeSchema.parse(makeRoute())).toEqual(makeRoute());
  });

  it("rejects unknown fields and empty required checkpoints", () => {
    expect(routeSchema.safeParse({ ...makeRoute(), surprise: true }).success).toBe(false);
    expect(routeSchema.safeParse({ ...makeRoute(), checkpoints: [] }).success).toBe(false);
  });

  it("allows literal private origins only for explicit fixtures", () => {
    const route = makeRoute();
    route.browser.navigationOrigins = [{ origin: "http://169.254.169.254", purpose: "external" }];
    expect(routeSchema.safeParse(route).success).toBe(false);
    route.browser.navigationOrigins = [{ origin: "http://127.0.0.1:4173", purpose: "fixture" }];
    expect(routeSchema.safeParse(route).success).toBe(true);
  });

  it("requires filesystem checkpoints to use declared roots", () => {
    const route = makeRoute();
    route.checkpoints = [
      {
        checkpointId: "file_check",
        kind: "filesystem",
        timing: "final",
        rootId: "other_root",
        relativePath: "report.json",
        assertion: { kind: "exists", entryType: "file" },
      },
    ];
    expect(routeSchema.safeParse(route).success).toBe(false);
  });
});

describe("action and decision contracts", () => {
  const baseIntent = {
    actionId: "action_one",
    runId: "run_one",
    routePolicyHash: hash,
    observation: {
      adapter: "browser" as const,
      hostId: "host_test",
      resourceId: "tab_one",
      resourceGeneration: "generation_one",
      snapshotId: "snapshot_one",
      observedAt: 1,
    },
    intentRecordedAt: 1,
  };

  it("accepts only observed target references, not selectors or coordinates", () => {
    const target = {
      targetId: "target_one",
      resourceGeneration: "generation_one",
      snapshotId: "snapshot_one",
    };
    expect(actionIntentSchema.safeParse({ ...baseIntent, action: { kind: "browser.click", target } }).success).toBe(true);
    expect(
      actionIntentSchema.safeParse({
        ...baseIntent,
        action: { kind: "browser.click", target, selector: "#pay", x: 10, y: 20 },
      }).success,
    ).toBe(false);
  });

  it("does not accept raw text in a typing action", () => {
    const target = {
      targetId: "target_one",
      resourceGeneration: "generation_one",
      snapshotId: "snapshot_one",
    };
    expect(
      actionIntentSchema.safeParse({
        ...baseIntent,
        action: { kind: "browser.type", target, value: "secret-or-model-text" },
      }).success,
    ).toBe(false);
    expect(
      actionIntentSchema.safeParse({
        ...baseIntent,
        action: { kind: "browser.type", target, value: { kind: "protected-ref", dataRefId: "login_email" } },
      }).success,
    ).toBe(true);
  });

  it("requires complete normalized probability distributions", () => {
    const valid = {
      operationChoiceId: "click",
      targetChoiceId: "target_one",
      operationProbabilities: [{ choiceId: "click", probability: 1 }],
      targetProbabilities: [{ choiceId: "target_one", probability: 1 }],
      confidence: 0.9,
      providerModel: "jev-test",
      latencyMs: 50,
    };
    expect(decisionResponseSchema.safeParse(valid).success).toBe(true);
    expect(
      decisionResponseSchema.safeParse({
        ...valid,
        operationProbabilities: [{ choiceId: "click", probability: 0.4 }],
      }).success,
    ).toBe(false);
  });
});

describe("approval and artifact contracts", () => {
  it("requires a scoped, expiring, single-use user approval", () => {
    const approval = {
      approvalId: "approval_one",
      runId: "run_one",
      actionId: "action_one",
      targetId: "target_one",
      targetGeneration: "generation_one",
      userId: "user_one",
      routePolicyHash: hash,
      stateHash: hash,
      issuedAt: 100,
      expiresAt: 200,
      singleUse: true,
    };
    expect(approvalGrantSchema.safeParse(approval).success).toBe(true);
    expect(approvalGrantSchema.safeParse({ ...approval, expiresAt: 100 }).success).toBe(false);
    expect(approvalGrantSchema.safeParse({ ...approval, singleUse: false }).success).toBe(false);
  });

  it("bounds export selections and byte ranges", () => {
    expect(
      createArtifactShareInputSchema.safeParse({
        runId: "run_one",
        artifactIds: ["artifact_one", "artifact_one"],
        expiresInSeconds: 604_800,
        audience: "anyone-with-link",
      }).success,
    ).toBe(false);
    expect(artifactRangeSchema.safeParse({ start: 0, endInclusive: 1_048_575 }).success).toBe(true);
    expect(artifactRangeSchema.safeParse({ start: 0, endInclusive: 1_048_576 }).success).toBe(false);
  });
});
