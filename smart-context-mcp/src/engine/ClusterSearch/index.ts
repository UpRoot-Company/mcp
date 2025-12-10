import { SymbolIndex } from "../../ast/SymbolIndex.js";
import { CallGraphBuilder } from "../../ast/CallGraphBuilder.js";
import { TypeDependencyTracker } from "../../ast/TypeDependencyTracker.js";
import { ClusterSearchResponse, ExpansionState, SearchCluster } from "../../types/cluster.js";
import { QueryParser } from "./QueryParser.js";
import { SeedFinder } from "./SeedFinder.js";
import { ClusterBuilder, BuildClusterOptions, ExpandableRelationship, ExpandRelationshipOptions as BuilderExpandRelationshipOptions } from "./ClusterBuilder.js";
import { ClusterRanker } from "./ClusterRanker.js";
import { PreviewGenerator } from "./PreviewGenerator.js";

const DEFAULT_MAX_CLUSTERS = 5;
const DEFAULT_TOKEN_BUDGET = 5000;

export interface ClusterSearchEngineDeps {
    rootPath: string;
    symbolIndex: SymbolIndex;
    callGraphBuilder: CallGraphBuilder;
    typeDependencyTracker: TypeDependencyTracker;
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

export class ClusterSearchEngine {
    private readonly queryParser = new QueryParser();
    private readonly seedFinder: SeedFinder;
    private readonly clusterBuilder: ClusterBuilder;
    private readonly clusterRanker = new ClusterRanker();
    private readonly previewGenerator: PreviewGenerator;
    private readonly clusterCache = new Map<string, SearchCluster>();

    constructor(deps: ClusterSearchEngineDeps) {
        this.seedFinder = new SeedFinder(deps.symbolIndex);
        this.clusterBuilder = new ClusterBuilder(
            deps.rootPath,
            deps.symbolIndex,
            deps.callGraphBuilder,
            deps.typeDependencyTracker
        );
        this.previewGenerator = new PreviewGenerator(deps.rootPath);
    }

    async search(query: string, options: ClusterSearchOptions = {}): Promise<ClusterSearchResponse> {
        const start = Date.now();
        const parsed = this.queryParser.parse(query);
        const maxClusters = options.maxClusters ?? DEFAULT_MAX_CLUSTERS;
        if (parsed.terms.length === 0 && !parsed.filters.file) {
            return this.emptyResponse(start, options.tokenBudget);
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
        ranked.forEach(cluster => this.clusterCache.set(cluster.clusterId, cluster));
        const perCluster = ranked.map(cluster => cluster.metadata.tokenEstimate);
        const estimatedTokens = perCluster.reduce((sum, value) => sum + value, 0);
        const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
        const searchTime = `${Date.now() - start}ms`;
        const truncatedRelationships = this.collectTruncatedRelationships(ranked);

        return {
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
    }

    async expandClusterRelationship(
        clusterId: string,
        relationship: ExpandableRelationship,
        options: ClusterExpansionOptions = {}
    ): Promise<SearchCluster | null> {
        const cluster = this.clusterCache.get(clusterId);
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
        this.clusterCache.set(cluster.clusterId, cluster);
        return cluster;
    }

    invalidateFile(_filePath?: string): void {
        this.clusterCache.clear();
    }

    invalidateDirectory(_directoryPath?: string): void {
        this.clusterCache.clear();
    }

    clearCache(): void {
        this.clusterCache.clear();
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
}