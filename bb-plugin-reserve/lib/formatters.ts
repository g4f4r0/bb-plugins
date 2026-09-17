// Four formatter kinds share a strict 16-entry LRU, including explicit locales.
const formatters = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
export function formatter<T extends Intl.NumberFormat | Intl.DateTimeFormat>(kind: string, locale: string | undefined, create: () => T): T {
  const key = JSON.stringify([kind, locale ?? null]);
  const existing = formatters.get(key);
  if (existing) { formatters.delete(key); formatters.set(key, existing); return existing as T; }
  const next = create();
  if (formatters.size >= 16) formatters.delete(formatters.keys().next().value!);
  formatters.set(key, next);
  return next;
}
