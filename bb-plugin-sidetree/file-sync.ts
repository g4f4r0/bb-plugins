export const DISK_CONFLICT =
  "This file changed on disk. Reload, then save again.";

export function fileSyncAction(
  currentSha256: string | null,
  nextSha256: string,
  dirty: boolean,
): "same" | "reload" | "conflict" {
  if (currentSha256 === null || currentSha256 === nextSha256) return "same";
  return dirty ? "conflict" : "reload";
}

/** One contiguous edit, preserving unchanged prefix/suffix and mapped selections. */
export function textChange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } {
  let from = 0;
  const limit = Math.min(before.length, after.length);
  while (from < limit && before.charCodeAt(from) === after.charCodeAt(from))
    from++;
  // Do not split a UTF-16 surrogate pair.
  if (from > 0 && /[\uD800-\uDBFF]/u.test(before[from - 1]!)) from--;
  let to = before.length;
  let end = after.length;
  while (
    to > from &&
    end > from &&
    before.charCodeAt(to - 1) === after.charCodeAt(end - 1)
  ) {
    to--;
    end--;
  }
  if (to < before.length && /[\uDC00-\uDFFF]/u.test(before[to]!)) {
    to++;
    end++;
  }
  return { from, to, insert: after.slice(from, end) };
}
