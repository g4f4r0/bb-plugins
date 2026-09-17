/** A bounded LRU cache. Expiration is lazy, so it owns no background timers. */
export class PromiseCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();
  private readonly limit: number;
  private readonly ttl: number;
  constructor(limit = 128, ttl = 60_000) { this.limit = Math.max(1, limit); this.ttl = ttl; }
  get size() { return this.entries.size; }
  get(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const old = this.entries.get(key);
    if (old && now - old.at < this.ttl) {
      this.entries.delete(key); this.entries.set(key, old);
      return old.value;
    }
    const entry = { at: now, value: Promise.resolve().then(load) };
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    entry.value.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return entry.value;
  }
}
