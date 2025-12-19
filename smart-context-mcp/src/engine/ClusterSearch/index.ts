import { SymbolIndex } from "../../ast/SymbolIndex.js";
import { CallGraphBuilder } from "../../ast/CallGraphBuilder.js";
import { TypeDependencyTracker } from "../../ast/TypeDependencyTracker.js";
import { DependencyGraph } from "../../ast/DependencyGraph.js";
import { ClusterSearchResponse, ExpansionState, SearchCluster } from "../../types/cluster.js";
import { QueryParser } from "./QueryParser.js";
import { SeedFinder } from "./SeedFinder.js";
import { ClusterBuilder, BuildClusterOptions, ExpandableRelationship, ExpandRelationshipOptions as BuilderExpandRelationshipOptions } from "./ClusterBuilder.js";
import { ClusterRanker } from "./ClusterRanker.js";
import { PreviewGenerator } from "./PreviewGenerator.js";
import { CacheableSearchOptions, ClusterCache, ClusterCacheConfig } from "./ClusterCache.js";
import { HotSpotDetector } from "./HotSpotDetector.js";
import { ClusterPrecomputationEngine, ClusterPrecomputationConfig } from "./ClusterPrecomputationEngine.js";
import { IFileSystem } from "../../platform/FileSystem.js";

const DEFAULT_MAX_CLUSTERS = 5;
const DEFAULT_TOKEN_BUDGET = 5000;

export interface ClusterSearchEngineDeps {
    rootPath: string;
    symbolIndex: SymbolIndex;
    callGraphBuilder: CallGraphBuilder;
    typeDependencyTracker: TypeDependencyTracker;
    dependencyGraph: DependencyGraph;
    fileSystem: IFileSystem;
}

export interface ClusterSearchOptions {
    maxClusters?: number;
    expandRelationships?: BuildClusterOptions["expandRelationships"];
    tokenBudget?: number;
    expansionDepth?: number;
    includePreview?: boolean;
}

export interface ClusterExpansionOptions extends BuilderExpandRelationshipOptions {
    includePreview?: boolean;
}

export interface ClusterSearchEngineConfig {
    cache?: ClusterCacheConfig;
    precomputation?: ClusterPrecomputationConfig & { enabled?: boolean };
}

export class ClusterSearchEngine {
    private readonly queryParser = new QueryParser();
    private readonly seedFinder: SeedFinder;
    private readonly clusterBuilder: ClusterBuilder;
    private readonly clusterRanker = new ClusterRanker();
    private readonly previewGenerator: PreviewGenerator;
    private readonly clusterCache: ClusterCache;
    private readonly hotSpotDetector?: HotSpotDetector;
    private readonly precomputationEngine?: ClusterPrecomputationEngine;
    private readonly precomputationEnabled: boolean;

    constructor(deps: ClusterSearchEngineDeps, config: ClusterSearchEngineConfig = {}) {
        this.seedFinder = new SeedFinder(deps.symbolIndex);
        this.clusterBuilder = new ClusterBuilder(
            deps.rootPath,
            deps.symbolIndex,
            deps.callGraphBuilder,
            deps.typeDependencyTracker
        );
        this.previewGenerator = new PreviewGenerator(deps.rootPath, deps.fileSystem);
        this.clusterCache = new ClusterCache(deps.rootPath, config.cache);
        this.precomputationEnabled = config.precomputation?.enabled !== false;
        if (this.precomputationEnabled) {
            this.hotSpotDetector = new HotSpotDetector(deps.symbolIndex, deps.dependencyGraph);
            this.precomputationEngine = new ClusterPrecomputationEngine(
                this.hotSpotDetector,
                (query, options) => this.search(query, options),
                config.precomputation,
                (message, ...args) => {
                    if (process.env.SMART_CONTEXT_DEBUG === "true") {
                        console.error(message, ...args);
                    }
                }
            );
        }
    }

    async search(query: string, options: ClusterSearchOptions = {}): Promise<ClusterSearchResponse> {
        const start = Date.now();
        const parsed = this.queryParser.parse(query);
        const maxClusters = options.maxClusters ?? DEFAULT_MAX_CLUSTERS;
        if (parsed.terms.length === 0 && !parsed.filters.file) {
            return this.emptyResponse(start, options.tokenBudget);
        }

        const cacheOptions = this.buildCacheableOptions(options);
        const cached = this.clusterCache.getCachedResponse(query, cacheOptions);
        if (cached) {
            const elapsed = Date.now() - start;
            return {
                ...cached.response,
                searchTime: `${elapsed}ms (cached)`
            };
        }

        const seedLimit = Math.max(maxClusters * 2, maxClusters);
        const seeds = await this.seedFinder.findSeeds(parsed, seedLimit);
        if (seeds.length === 0) {
            return this.emptyResponse(start, options.tokenBudget);
        }

        const includePreview = options.includePreview !== false;

        const clusters = await Promise.all(
            seeds.map(seed => this.clusterBuilder.buildCluster(seed, {
                expandRelationships: options.expandRelationships,
                depth: options.expansionDepth
            }))
        );

        const ranked = this.clusterRanker.rank(clusters).slice(0, maxClusters);
        if (includePreview) {
            await this.previewGenerator.applyPreviews(ranked);
        }
        const perCluster = ranked.map(cluster => cluster.metadata.tokenEstimate);
        const estimatedTokens = perCluster.reduce((sum, value) => sum + value, 0);
        const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
        const searchTime = `${Date.now() - start}ms`;
        const truncatedRelationships = this.collectTruncatedRelationships(ranked);

        const response: ClusterSearchResponse = {
            clusters: ranked,
            totalMatches: seeds.length,
            searchTime,
            tokenUsage: {
                estimated: estimatedTokens,
                budget: tokenBudget,
                perCluster
            },
            expansionHints: {
                truncatedRelationships,
                recommendedExpansions: this.collectRecommendedExpansions(ranked)
            }
        };

        this.clusterCache.storeResponse(query, cacheOptions, response);
        return response;
    }

    async expandClusterRelationship(
        clusterId: string,
        relationship: ExpandableRelationship,
        options: ClusterExpansionOptions = {}
    ): Promise<SearchCluster | null> {
        const cluster = this.clusterCache.getCluster(clusterId);
        if (!cluster || cluster.seeds.length === 0) {
            return null;
        }
        const seed = cluster.seeds[0];
        const builderOptions: BuilderExpandRelationshipOptions = {
            depth: options.depth,
            limit: options.limit
        };
        cluster.related[relationship] = await this.clusterBuilder.expandRelationship(seed, relationship, builderOptions);
        this.clusterBuilder.recalculateMetadata(cluster);
        if (options.includePreview !== false) {
            await this.previewGenerator.applyPreviews([cluster]);
        }
        this.clusterCache.updateCluster(cluster);
        return cluster;
    }

    invalidateFile(filePath?: string): void {
        this.clusterCache.invalidateByFile(filePath);
        this.precomputationEngine?.requestImmediateRun();
    }

    invalidateDirectory(directoryPath?: string): void {
        this.clusterCache.invalidateByDirectory(directoryPath);
        this.precomputationEngine?.requestImmediateRun();
    }

    clearCache(): void {
        this.clusterCache.clear();
    }

    startBackgroundTasks(): void {
        if (!this.precomputationEnabled) {
            return;
        }
        this.precomputationEngine?.start();
    }

    stopBackgroundTasks(): void {
        this.precomputationEngine?.stop();
    }

    public async getHotSpots(): Promise<any[]> {
        if (!this.hotSpotDetector) return [];
        return this.hotSpotDetector.detectHotSpots();
    }

    private collectRecommendedExpansions(clusters: SearchCluster[]): string[] {
        const relationships: ExpandableRelationship[] = ["callers", "callees", "typeFamily"];
        const recommendations: string[] = [];
        for (const cluster of clusters) {
            for (const relationship of relationships) {
                const container = cluster.related[relationship];
                if (!container) continue;
                if (container.state === ExpansionState.NOT_LOADED) {
                    recommendations.push(`${cluster.clusterId}:${relationship}`);
                } else if (container.state === ExpansionState.TRUNCATED) {
                    recommendations.push(`${cluster.clusterId}:${relationship}:expand`);
                }
            }
        }
        return recommendations;
    }

    private collectTruncatedRelationships(clusters: SearchCluster[]): Array<{ clusterId: string; relationship: string; availableCount: number; }> {
        const truncated: Array<{ clusterId: string; relationship: string; availableCount: number; }> = [];
        for (const cluster of clusters) {
            for (const [relationship, container] of Object.entries(cluster.related)) {
                if (container.state === ExpansionState.TRUNCATED) {
                    truncated.push({
                        clusterId: cluster.clusterId,
                        relationship,
                        availableCount: container.totalCount ?? container.data.length
                    });
                }
            }
        }
        return truncated;
    }

    private emptyResponse(start: number, tokenBudget?: number): ClusterSearchResponse {
        return {
            clusters: [],
            totalMatches: 0,
            searchTime: `${Date.now() - start}ms`,
            tokenUsage: {
                estimated: 0,
                budget: tokenBudget ?? DEFAULT_TOKEN_BUDGET,
                perCluster: []
            },
            expansionHints: {
                truncatedRelationships: [],
                recommendedExpansions: []
            }
        };
    }

    private buildCacheableOptions(options: ClusterSearchOptions): CacheableSearchOptions {
        return {
            maxClusters: options.maxClusters ?? DEFAULT_MAX_CLUSTERS,
            expansionDepth: options.expansionDepth ?? 2,
            includePreview: options.includePreview !== false,
            expandRelationships: options.expandRelationships
        };
    }
}