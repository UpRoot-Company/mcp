export class LRUCache<K, V> {
    private readonly cache = new Map<K, { value: V; lastAccess: number }>();

    constructor(
        private readonly maxSize: number,
        private readonly ttlMs: number,
        private readonly onEvict?: (key: K, value: V) => void
    ) {}

    public get(key: K): V | undefined {
        const entry = this.cache.get(key);
        if (!entry) {
            return undefined;
        }

        if (this.isExpired(entry)) {
            this.delete(key);
            return undefined;
        }

        entry.lastAccess = Date.now();
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    public set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.delete(oldest);
            }
        }

        this.cache.set(key, { value, lastAccess: Date.now() });
    }

    public cleanup(): void {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.lastAccess > this.ttlMs) {
                this.delete(key);
            }
        }
    }

    public clear(): void {
        for (const [key] of this.cache) {
            this.delete(key);
        }
    }

    public keys(): IterableIterator<K> {
        return this.cache.keys();
    }

    public delete(key: K): void {
        this.performDelete(key);
    }

    private isExpired(entry: { lastAccess: number }): boolean {
        return Date.now() - entry.lastAccess > this.ttlMs;
    }

    private performDelete(key: K): void {
        const entry = this.cache.get(key);
        if (!entry) {
            return;
        }
        this.cache.delete(key);
        if (this.onEvict) {
            this.onEvict(key, entry.value);
        }
    }
}
