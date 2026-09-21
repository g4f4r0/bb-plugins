import type { AdapterObservation } from "../contracts/adapter.js";
import type { Checkpoint, DataReference, TargetQuery } from "../contracts/route.js";
import type { CheckpointResult } from "../contracts/run.js";
import type { DataResolver } from "../fs/scoped-filesystem.js";

function matches(actual: string, expected: string, mode: "exact" | "contains", caseSensitive = true): boolean {
  const left = caseSensitive ? actual : actual.toLocaleLowerCase();
  const right = caseSensitive ? expected : expected.toLocaleLowerCase();
  return mode === "exact" ? left === right : left.includes(right);
}

function findTargets(observation: AdapterObservation, query: TargetQuery) {
  if (query.surface !== observation.identity.adapter) return [];
  return observation.targets.filter((target) => target.role === query.role && matches(target.name, query.name, query.match));
}

export async function verifyObservationCheckpoint(
  checkpoint: Checkpoint,
  observation: AdapterObservation,
  resolveData: DataResolver,
  signal: AbortSignal,
): Promise<CheckpointResult> {
  const observedAt = Date.now();
  let outcome: CheckpointResult["outcome"] = "unknown";
  let summary = "Checkpoint is unsupported by this observation adapter";
  if (checkpoint.kind === "visible-text" && checkpoint.surface === observation.identity.adapter) {
    outcome = matches(observation.text, checkpoint.text, checkpoint.match, checkpoint.caseSensitive) ? "pass" : "fail";
    summary = outcome === "pass" ? "Visible text predicate matches" : "Visible text predicate differs";
  } else if (checkpoint.kind === "control-state") {
    const targets = findTargets(observation, checkpoint.target);
    if (targets.length === 1) {
      const target = targets[0]!;
      const enabled = !target.allowedOperations.every((operation) => operation === "scroll");
      const supported = checkpoint.state === "visible" || checkpoint.state === "enabled" || checkpoint.state === "disabled";
      if (supported) {
        outcome = checkpoint.state === "visible" || (checkpoint.state === "enabled" ? enabled : !enabled) ? "pass" : "fail";
        summary = outcome === "pass" ? "Control state predicate matches" : "Control state predicate differs";
      }
    } else if (targets.length > 1) {
      summary = "Control query is ambiguous";
    } else {
      outcome = checkpoint.state === "hidden" ? "pass" : "fail";
      summary = outcome === "pass" ? "Control is not visible" : "Control was not found";
    }
  } else if (checkpoint.kind === "field-value") {
    const targets = findTargets(observation, checkpoint.target);
    if (targets.length === 1 && targets[0]!.valueSummary !== null) {
      const expected = await resolveData(checkpoint.expected, signal);
      outcome = matches(targets[0]!.valueSummary!, expected, checkpoint.comparison === "equals" ? "exact" : "contains") ? "pass" : "fail";
      summary = outcome === "pass" ? "Field value predicate matches" : "Field value predicate differs";
    } else {
      summary = targets.length > 1 ? "Field query is ambiguous" : "Field value is unavailable";
    }
  }
  return { checkpoint, outcome, observedAt, summary, evidenceArtifactIds: [] };
}

export async function resolveSyntheticOnly(reference: DataReference): Promise<string> {
  if (reference.kind === "synthetic-literal") return reference.value;
  throw new Error("Protected data requires an injected resolver");
}
