import crypto from 'crypto';
import { LRUCache } from 'lru-cache';

type CacheEntry = any;

export class CachingStrategy {
  private readonly resultCache: LRUCache<string, CacheEntry>;
  private readonly workflowCache: LRUCache<string, CacheEntry>;
  private readonly projectId: string;

  constructor(projectId: string = process.cwd()) {
    this.projectId = projectId;
    this.resultCache = new LRUCache({ max: 200, ttl: 60_000 });
    this.workflowCache = new LRUCache({ max: 100, ttl: 60_000 });
  }

  public getCacheKey(pillar: string, args: any): string {
    const normalized = this.normalizeArgs(args);
    const payload = JSON.stringify({
      pillar,
      args: normalized,
      projectId: this.projectId
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  public get<T>(pillar: string, args: any): T | undefined {
    const key = this.getCacheKey(pillar, args);
    return this.resultCache.get(key) as T | undefined;
  }

  public set<T>(pillar: string, args: any, value: T): void {
    const key = this.getCacheKey(pillar, args);
    this.resultCache.set(key, value as CacheEntry);
  }

  public async getCachedOrExecute<T>(
    pillar: string,
    args: any,
    executor: () => Promise<T>,
    options?: { shouldCache?: (value: T) => boolean }
  ): Promise<T> {
    const key = this.getCacheKey(pillar, args);
    const cached = this.resultCache.get(key) as T | undefined;
    if (cached !== undefined) {
      return cached;
    }

    const result = await executor();
    const shouldCache = options?.shouldCache ?? (() => true);
    if (shouldCache(result)) {
      this.resultCache.set(key, result as CacheEntry);
    }
    return result;
  }

  public cacheWorkflow(key: string, value: CacheEntry): void {
    this.workflowCache.set(key, value);
  }

  public getCachedWorkflow<T>(key: string): T | undefined {
    return this.workflowCache.get(key) as T | undefined;
  }

  private normalizeArgs(args: any): any {
    if (args === null || args === undefined) return args;
    if (typeof args !== 'object') return args;
    if (Array.isArray(args)) {
      return args.map((value) => this.normalizeArgs(value));
    }

    const entries = Object.entries(args)
      .filter(([_, value]) => typeof value !== 'function' && value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));

    const normalized: Record<string, any> = {};
    for (const [key, value] of entries) {
      normalized[key] = this.normalizeArgs(value);
    }
    return normalized;
  }
}
