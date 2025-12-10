import * as path from "path";
import { ClusterSearchResponse, SearchCluster } from "../../types/cluster.js";

export interface CacheableSearchOptions {
    maxClusters: number;
    expansionDepth: number;
    includePreview: boolean;
    expandRelationships?: Record<string, boolean | undefined>;
}

export interface ClusterCacheConfig {
    ttlMs?: number;
    maxEntries?: number;
}

interface CacheEntry {
    response: ClusterSearchResponse;
    storedAt: number;
    hitCount: number;
    clusterIds: string[];
    fileRefs: Set<string>;
}

const DEFAULT_CACHE_CONFIG: Required<ClusterCacheConfig> = {
    ttlMs: 5 * 60 * 1000,
    maxEntries: 50
};

export class ClusterCache {
    private readonly responseCache = new Map<string, CacheEntry>();
    private readonly clusterIndex = new Map<string, SearchCluster>();
    private readonly clusterFileRefs = new Map<string, Set<string>>();
    private readonly clusterToEntries = new Map<string, Set<string>>();

    private readonly config: Required<ClusterCacheConfig>;

    constructor(private readonly rootPath: string, config: ClusterCacheConfig = {}) {
        this.config = {
            ttlMs: config.ttlMs ?? DEFAULT_CACHE_CONFIG.ttlMs,
            maxEntries: config.maxEntries ?? DEFAULT_CACHE_CONFIG.maxEntries
        };
    }

    getCachedResponse(query: string, options: CacheableSearchOptions): { cacheKey: string; response: ClusterSearchResponse } | null {
        const cacheKey = this.buildCacheKey(query, options);
        const entry = this.responseCache.get(cacheKey);
        if (!entry) {
            return null;
        }
        if (this.isExpired(entry)) {
            this.dropCacheEntry(cacheKey);
            return null;
        }
        entry.hitCount++;
        return { cacheKey, response: entry.response };
    }

    storeResponse(query: string, options: CacheableSearchOptions, response: ClusterSearchResponse): void {
        const cacheKey = this.buildCacheKey(query, options);
        const entry: CacheEntry = {
            response,
            storedAt: Date.now(),
            hitCount: 0,
            clusterIds: response.clusters.map(cluster => cluster.clusterId),
            fileRefs: new Set()
        };

        response.clusters.forEach(cluster => {
            this.clusterIndex.set(cluster.clusterId, cluster);
            const fileRefs = this.collectClusterFileRefs(cluster);
            this.clusterFileRefs.set(cluster.clusterId, fileRefs);
            for (const ref of fileRefs) {
                entry.fileRefs.add(ref);
            }
            let entrySet = this.clusterToEntries.get(cluster.clusterId);
            if (!entrySet) {
                entrySet = new Set();
                this.clusterToEntries.set(cluster.clusterId, entrySet);
            }
            entrySet.add(cacheKey);
        });

        this.responseCache.set(cacheKey, entry);
        this.evictIfNeeded();
    }

    getCluster(clusterId: string): SearchCluster | undefined {
        return this.clusterIndex.get(clusterId);
    }

    updateCluster(cluster: SearchCluster): void {
        this.clusterIndex.set(cluster.clusterId, cluster);
        const refs = this.collectClusterFileRefs(cluster);
        this.clusterFileRefs.set(cluster.clusterId, refs);
        const entryKeys = this.clusterToEntries.get(cluster.clusterId);
        if (!entryKeys) {
            return;
        }
        for (const key of entryKeys) {
            const entry = this.responseCache.get(key);
            if (entry) {
                entry.fileRefs = this.buildEntryFileRefs(entry.clusterIds);
            }
        }
    }

    invalidateByFile(filePath?: string): void {
        if (!filePath) {
            this.clear();
            return;
        }
        const normalized = this.normalizeAbsPath(filePath);
        if (!normalized) {
            return;
        }
        for (const [clusterId, refs] of this.clusterFileRefs) {
            if (refs.has(normalized)) {
                this.dropCluster(clusterId);
            }
        }
        for (const [key, entry] of this.responseCache) {
            if (entry.fileRefs.has(normalized)) {
                this.dropCacheEntry(key);
            }
        }
    }

    invalidateByDirectory(directoryPath?: string): void {
        if (!directoryPath) {
            this.clear();
            return;
        }
        const normalizedDir = this.normalizeAbsPath(directoryPath);
        if (!normalizedDir) {
            return;
        }
        for (const [clusterId, refs] of this.clusterFileRefs) {
            if (this.refSetTouchesDirectory(refs, normalizedDir)) {
                this.dropCluster(clusterId);
            }
        }
        for (const [key, entry] of this.responseCache) {
            if (this.refSetTouchesDirectory(entry.fileRefs, normalizedDir)) {
                this.dropCacheEntry(key);
            }
        }
    }

    clear(): void {
        this.responseCache.clear();
        this.clusterIndex.clear();
        this.clusterFileRefs.clear();
        this.clusterToEntries.clear();
    }

    buildCacheKey(query: string, options: CacheableSearchOptions): string {
        return `${query}::${this.serializeOptions(options)}`;
    }

    private evictIfNeeded(): void {
        while (this.responseCache.size > this.config.maxEntries) {
            const oldestKey = this.responseCache.keys().next().value;
            if (!oldestKey) {
                break;
            }
            this.dropCacheEntry(oldestKey);
        }
    }

    private dropCluster(clusterId: string): void {
        const entryKeys = this.clusterToEntries.get(clusterId);
        if (entryKeys) {
            for (const key of entryKeys) {
                this.dropCacheEntry(key);
            }
            this.clusterToEntries.delete(clusterId);
        }
        this.clusterIndex.delete(clusterId);
        this.clusterFileRefs.delete(clusterId);
    }

    private dropCacheEntry(key: string): void {
        const entry = this.responseCache.get(key);
        if (!entry) {
            return;
        }
        this.responseCache.delete(key);
        for (const clusterId of entry.clusterIds) {
            const entrySet = this.clusterToEntries.get(clusterId);
            if (!entrySet) {
                continue;
            }
            entrySet.delete(key);
            if (entrySet.size === 0) {
                this.clusterToEntries.delete(clusterId);
                this.clusterIndex.delete(clusterId);
                this.clusterFileRefs.delete(clusterId);
            }
        }
    }

    private isExpired(entry: CacheEntry): boolean {
        return Date.now() - entry.storedAt > this.config.ttlMs;
    }

    private buildEntryFileRefs(clusterIds: string[]): Set<string> {
        const refs = new Set<string>();
        for (const clusterId of clusterIds) {
            const clusterRefs = this.clusterFileRefs.get(clusterId);
            if (!clusterRefs) {
                continue;
            }
            for (const ref of clusterRefs) {
                refs.add(ref);
            }
        }
        return refs;
    }

    private collectClusterFileRefs(cluster: SearchCluster): Set<string> {
        const refs = new Set<string>();
        const add = (filePath?: string) => {
            if (!filePath) return;
            const normalized = this.normalizeAbsPath(filePath);
            if (normalized) {
                refs.add(normalized);
            }
        };
        cluster.seeds.forEach(seed => add(seed.filePath));
        Object.values(cluster.related).forEach(container => {
            container.data.forEach(symbol => add(symbol.filePath));
        });
        return refs;
    }

    private normalizeAbsPath(filePath: string): string | null {
        if (!filePath) {
            return null;
        }
        const absPath = path.isAbsolute(filePath)
            ? path.normalize(filePath)
            : path.normalize(path.resolve(this.rootPath, filePath));
        return absPath;
    }

    private refSetTouchesDirectory(refs: Set<string>, directory: string): boolean {
        for (const ref of refs) {
            if (this.isWithinDirectory(ref, directory)) {
                return true;
            }
        }
        return false;
    }

    private isWithinDirectory(filePath: string, directory: string): boolean {
        const relative = path.relative(directory, filePath);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    }

    private serializeOptions(options: CacheableSearchOptions): string {
        const normalizedExpand = this.normalizeExpandRelationships(options.expandRelationships);
        return JSON.stringify({
            maxClusters: options.maxClusters,
            expansionDepth: options.expansionDepth,
            includePreview: options.includePreview,
            expandRelationships: normalizedExpand
        });
    }

    private normalizeExpandRelationships(input?: Record<string, boolean | undefined>): Record<string, boolean> | undefined {
        if (!input) {
            return undefined;
        }
        const entries = Object.entries(input)
            .filter(([, value]) => typeof value === "boolean")
            .map(([key, value]) => [key, value as boolean] as [string, boolean])
            .sort(([a], [b]) => a.localeCompare(b));
        if (entries.length === 0) {
            return undefined;
        }
        return Object.fromEntries(entries);
    }
}
