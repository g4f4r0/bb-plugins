/** Bounded least-recently-used storage. Eviction never owns live connections. */
export class LruMap<K, V> extends Map<K, V> {
  constructor(private readonly capacity: number, private readonly evict?: (key: K, value: V) => void) {
    super();
    if (capacity < 1) throw new Error('LRU capacity must be positive');
  }
  override get(key: K): V | undefined {
    const value = super.get(key);
    if (super.has(key)) { super.delete(key); super.set(key, value!); }
    return value;
  }
  override set(key: K, value: V): this {
    super.delete(key); super.set(key, value);
    while (this.size > this.capacity) {
      const [oldKey, oldValue] = this.entries().next().value!;
      super.delete(oldKey); this.evict?.(oldKey, oldValue);
    }
    return this;
  }
}
