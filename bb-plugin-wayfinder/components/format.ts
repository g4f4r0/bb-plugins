export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatFrameAge(ms: number | null): string {
  if (ms === null) return "no frame";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

export const TERMINAL_RUN_STATES = new Set(["passed", "failed", "blocked", "cancelled", "timed_out", "interrupted"]);

export const RUN_STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_confirmation: "Awaiting confirmation",
  verifying: "Verifying",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  interrupted: "Interrupted",
};

export function errorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const extract = (value: unknown): string | null => {
    if (typeof value === "string") return value.trim() || null;
    if (value === null || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error", "cause"]) {
      const message = extract(record[key]);
      if (message !== null) return message;
    }
    return null;
  };
  return (extract(error) ?? "Request failed").slice(0, 300);
}
