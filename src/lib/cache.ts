import "server-only";

/** Bounded process-local LRU. No disk persistence. */
export class LruCache<T> {
  private values = new Map<string, { value: T; expires: number }>();
  constructor(private capacity = 300, private ttl = 86_400_000, private now = Date.now) {}
  get(key: string): T | undefined {
    const item = this.values.get(key);
    if (!item) return;
    this.values.delete(key);
    if (item.expires <= this.now()) return;
    this.values.set(key, item);
    return item.value;
  }
  set(key: string, value: T) {
    this.values.delete(key);
    this.values.set(key, { value, expires: this.now() + this.ttl });
    if (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value!);
  }
}
