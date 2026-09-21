import type { ApprovalGrant } from "../contracts/run.js";
import { approvalGrantSchema } from "../contracts/run.js";
import { wayfinderError } from "../core/errors.js";

export class ApprovalRegistry {
  readonly #grants = new Map<string, ApprovalGrant>();
  readonly #consumed = new Set<string>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  add(value: unknown): ApprovalGrant {
    const grant = approvalGrantSchema.parse(value);
    if (this.#grants.has(grant.approvalId)) throw wayfinderError("policy-denied", "act", "Approval ID is already registered");
    this.#grants.set(grant.approvalId, grant);
    return grant;
  }

  consume(expected: {
    approvalId: string;
    runId: string;
    actionId: string;
    targetId: string;
    targetGeneration: string;
    routePolicyHash: string;
    stateHash: string;
    userId: string;
  }): ApprovalGrant {
    const grant = this.#grants.get(expected.approvalId);
    if (grant === undefined || this.#consumed.has(expected.approvalId)) {
      throw wayfinderError("policy-denied", "act", "Approval is missing or was already consumed");
    }
    if (grant.expiresAt <= this.#now()) {
      throw wayfinderError("policy-denied", "act", "Approval has expired");
    }
    if (grant.issuedAt > this.#now()) throw wayfinderError("policy-denied", "act", "Approval is not valid yet");
    const exact =
      grant.runId === expected.runId &&
      grant.actionId === expected.actionId &&
      grant.targetId === expected.targetId &&
      grant.targetGeneration === expected.targetGeneration &&
      grant.routePolicyHash === expected.routePolicyHash &&
      grant.stateHash === expected.stateHash &&
      grant.userId === expected.userId;
    if (!exact) throw wayfinderError("policy-denied", "act", "Approval does not match the exact action and observed state");
    this.#consumed.add(expected.approvalId);
    return grant;
  }
}
