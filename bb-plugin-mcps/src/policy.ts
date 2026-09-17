import type { JsonRecord, ToolRisk } from "./types.js";

export function classifyTool(annotations: JsonRecord | undefined): ToolRisk {
  if (annotations?.destructiveHint === true) return "destructive";
  if (annotations?.readOnlyHint === true) return "read";
  return "write";
}
