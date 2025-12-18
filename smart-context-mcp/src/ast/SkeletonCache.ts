import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Stats } from 'fs';
import { LRUCache } from '../utils/LRUCache.js';
import type { SkeletonOptions } from '../types.js';

interface CachedSkeleton {
    mtime: number;
    skeleton: string;
    optionsHash: string;
}

export class SkeletonCache {
    private readonly memoryCache: LRUCache<string, CachedSkeleton>;
    private readonly diskCacheDir: string;
    private l1Hits = 0;
    private l2Hits = 0;
    private misses = 0;

    constructor(
        projectRoot: string,
        memoryCacheSize = 1000,
        ttlMs = 60_000
    ) {
        this.memoryCache = new LRUCache(memoryCacheSize, ttlMs);
        this.diskCacheDir = path.join(projectRoot, '.mcp', 'smart-context', 'skeletons');
    }

    public async getSkeleton(
        filePath: string,
        options: SkeletonOptions = {},
        generator: (filePath: string, options: SkeletonOptions) => Promise<string>
    ): Promise<string> {
        let stat: Stats;
        try {
            stat = await fs.stat(filePath);
        } catch {
            return generator(filePath, options);
        }

        const mtime = stat.mtimeMs;
        const optionsHash = this.hashOptions(options);
        const cacheKey = this.getCacheKey(filePath, mtime, optionsHash);

        const memCached = this.memoryCache.get(cacheKey);
        if (memCached) {
            this.l1Hits++;
            return memCached.skeleton;
        }

        const diskCached = await this.loadFromDisk(filePath, mtime, optionsHash);
        if (diskCached) {
            this.l2Hits++;
            this.memoryCache.set(cacheKey, diskCached);
            return diskCached.skeleton;
        }

        this.misses++;
        const skeleton = await generator(filePath, options);
        const cached: CachedSkeleton = { mtime, skeleton, optionsHash };
        this.memoryCache.set(cacheKey, cached);
        void this.saveToDisk(filePath, cached).catch(error => {
            console.warn(`[SkeletonCache] Failed to save cache for ${path.basename(filePath)}:`, error);
        });
        return skeleton;
    }

    public async invalidate(filePath: string): Promise<void> {
        for (const key of this.memoryCache.keys()) {
            if (typeof key === 'string' && key.startsWith(`${filePath}:`)) {
                this.memoryCache.delete(key);
            }
        }

        const pathHash = this.hashPath(filePath);
        const dirPath = path.join(this.diskCacheDir, pathHash);
        await fs.rm(dirPath, { recursive: true, force: true });
    }

    public async clearAll(): Promise<void> {
        this.memoryCache.clear();
        await fs.rm(this.diskCacheDir, { recursive: true, force: true });
    }

    public getStats(): { memorySize: number; diskCacheDir: string; l1Hits: number; l2Hits: number; misses: number } {
        return {
            memorySize: this.memoryCache.size(),
            diskCacheDir: this.diskCacheDir,
            l1Hits: this.l1Hits,
            l2Hits: this.l2Hits,
            misses: this.misses
        };
    }

    private async loadFromDisk(filePath: string, expectedMtime: number, optionsHash: string): Promise<CachedSkeleton | null> {
        const cacheFilePath = this.getDiskCachePath(filePath, expectedMtime, optionsHash);
        try {
            const raw = await fs.readFile(cacheFilePath, 'utf-8');
            const cached = JSON.parse(raw) as CachedSkeleton;
            if (cached.mtime !== expectedMtime) {
                return null;
            }
            return cached;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code !== 'ENOENT') {
                console.warn('[SkeletonCache] Error loading cache:', error);
            }
            return null;
        }
    }

    private async saveToDisk(filePath: string, cached: CachedSkeleton): Promise<void> {
        const cacheFilePath = this.getDiskCachePath(filePath, cached.mtime, cached.optionsHash);
        await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
        await fs.writeFile(cacheFilePath, JSON.stringify(cached, null, 2), 'utf-8');
    }

    private getDiskCachePath(filePath: string, mtime: number, optionsHash: string): string {
        const pathHash = this.hashPath(filePath);
        const filename = `${mtime}-${optionsHash}.json`;
        return path.join(this.diskCacheDir, pathHash, filename);
    }

    private getCacheKey(filePath: string, mtime: number, optionsHash: string): string {
        return `${filePath}:${mtime}:${optionsHash}`;
    }

    private hashOptions(options: SkeletonOptions): string {
        const normalized = JSON.stringify({
            detailLevel: options.detailLevel || 'standard',
            includeComments: options.includeComments === true,
            includeMemberVars: options.includeMemberVars !== false,
            maxMemberPreview: Math.max(1, options.maxMemberPreview ?? 3)
        });
        return createHash('md5').update(normalized).digest('hex').slice(0, 8);
    }

    private hashPath(filePath: string): string {
        return createHash('md5').update(filePath).digest('hex').slice(0, 8);
    }
}
