export const MIN_BROWSER_AVAILABLE_BYTES = 1536 * 1024 * 1024;

export function availableMemoryBytes(meminfo: string) {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (!match) return undefined;
  const kib = Number(match[1]);
  return Number.isSafeInteger(kib) ? kib * 1024 : undefined;
}

export function assertBrowserMemory(meminfo: string) {
  const available = availableMemoryBytes(meminfo);
  if (available !== undefined && available < MIN_BROWSER_AVAILABLE_BYTES)
    throw new Error(
      "This machine is low on memory. Close an idle browser session or another heavy task, then retry.",
    );
}
