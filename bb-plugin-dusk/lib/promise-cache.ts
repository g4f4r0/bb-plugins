/** A bounded LRU cache. Expiration is lazy, so it owns no background timers. */
export class PromiseCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T>; resolved?: T }>();
  private readonly limit: number;
  private readonly ttl: number;
  constructor(limit = 128, ttl = 60_000) { this.limit = Math.max(1, limit); this.ttl = ttl; }
  get size() { return this.entries.size; }
  // Keep the last resolved value visible while get() revalidates an expired entry.
  peek(key: string): T | undefined { return this.entries.get(key)?.resolved; }
  get(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const old = this.entries.get(key);
    if (old && now - old.at < this.ttl) {
      this.entries.delete(key); this.entries.set(key, old);
      return old.value;
    }
    const entry = { at: now, value: Promise.resolve().then(load), resolved: old?.resolved };
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    entry.value.then(value => { entry.resolved = value; }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }
}
