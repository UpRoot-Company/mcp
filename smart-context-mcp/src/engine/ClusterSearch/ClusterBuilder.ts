import path from "path";
import { createHash } from "crypto";
import { SymbolIndex } from "../../ast/SymbolIndex.js";
import { CallGraphBuilder } from "../../ast/CallGraphBuilder.js";
import { TypeDependencyTracker } from "../../ast/TypeDependencyTracker.js";
import {
    DefinitionSymbol,
    SymbolInfo,
    TypeGraphResult,
    TypeGraphNode,
    TypeRelationKind,
    CallGraphResult
} from "../../types.js";
import {
    CLUSTER_TOKEN_BUDGET,
    ClusterSeed,
    ExpansionState,
    RelatedSymbol,
    RelatedSymbolsContainer,
    RelationshipType,
    SearchCluster,
    SearchClusterMetadata
} from "../../types/cluster.js";

const DEFAULT_MAX_COLOCATED = 10;
const DEFAULT_MAX_SIBLINGS = 6;
const MAX_CALL_RELATIONS = 15;
const MAX_TYPE_RELATIONS = 10;

export type ExpandableRelationship = "callers" | "callees" | "typeFamily";
type RelationshipKey = keyof SearchCluster["related"];

export interface BuildClusterOptions {
    depth?: number;
    expandRelationships?: {
        callers?: boolean;
        callees?: boolean;
        typeFamily?: boolean;
        colocated?: boolean;
        siblings?: boolean;
        all?: boolean;
    };
}

export interface ExpandRelationshipOptions {
    depth?: number;
    limit?: number;
}

export class ClusterBuilder {
    constructor(
        private readonly rootPath: string,
        private readonly symbolIndex: SymbolIndex,
        private readonly callGraphBuilder: CallGraphBuilder,
        private readonly typeDependencyTracker: TypeDependencyTracker,
        private readonly now: () => number = () => Date.now()
    ) {}

    async buildCluster(seed: ClusterSeed, options: BuildClusterOptions = {}): Promise<SearchCluster> {
        const depth = options.depth ?? 2;
        const related = this.createEmptyRelated();
        const expandConfig = options.expandRelationships ?? {};
        const expandAll = expandConfig.all === true;

        if (expandAll || expandConfig.colocated !== false) {
            related.colocated = await this.loadColocated(seed);
        }
        if (expandAll || expandConfig.siblings !== false) {
            related.siblings = await this.loadSiblings(seed);
        }

        const expensiveLoads: Promise<void>[] = [];
        const maybeQueue = (key: ExpandableRelationship, loader: () => Promise<RelatedSymbolsContainer>) => {
            if (expandAll || expandConfig[key]) {
                expensiveLoads.push(loader().then(container => {
                    related[key] = container;
                }));
            }
        };

        maybeQueue("callers", () => this.loadCallers(seed, depth));
        maybeQueue("callees", () => this.loadCallees(seed, depth));
        maybeQueue("typeFamily", () => this.loadTypeFamily(seed, depth));

        await Promise.allSettled(expensiveLoads);

        const metadata = this.computeMetadata(seed, related);

        return {
            clusterId: this.generateClusterId(seed),
            seeds: [seed],
            related,
            metadata
        };
    }

    async expandRelationship(
        seed: ClusterSeed,
        relationship: ExpandableRelationship,
        options: ExpandRelationshipOptions = {}
    ): Promise<RelatedSymbolsContainer> {
        const depth = options.depth ?? 2;
        const limit = options.limit;
        switch (relationship) {
            case "callers":
                return this.loadCallers(seed, depth, limit);
            case "callees":
                return this.loadCallees(seed, depth, limit);
            case "typeFamily":
                return this.loadTypeFamily(seed, depth, limit);
            default:
                return this.createContainer(ExpansionState.NOT_LOADED);
        }
    }

    recalculateMetadata(cluster: SearchCluster): SearchClusterMetadata {
        const seed = cluster.seeds[0];
        const metadata = this.computeMetadata(seed, cluster.related);
        cluster.metadata = metadata;
        return metadata;
    }

    private async loadColocated(seed: ClusterSeed): Promise<RelatedSymbolsContainer> {
        const absPath = this.resolveAbsolutePath(seed.filePath);
        try {
            const fileSymbols = await this.symbolIndex.getSymbolsForFile(absPath);
            const data = fileSymbols
                .filter(symbol => this.isColocatedCandidate(symbol, seed.symbol.name))
                .slice(0, DEFAULT_MAX_COLOCATED)
                .map(symbol => this.toRelatedSymbol(seed.filePath, symbol, "same-file"));
            return this.wrapAsLoaded(data);
        } catch (error) {
            return this.wrapAsFailed(error);
        }
    }

    private async loadSiblings(seed: ClusterSeed): Promise<RelatedSymbolsContainer> {
        if (!seed.symbol.container) {
            return this.wrapAsLoaded([]);
        }
        const absPath = this.resolveAbsolutePath(seed.filePath);
        try {
            const fileSymbols = await this.symbolIndex.getSymbolsForFile(absPath);
            const siblings = fileSymbols
                .filter(symbol => symbol.container === seed.symbol.container && symbol.name !== seed.symbol.name)
                .slice(0, DEFAULT_MAX_SIBLINGS)
                .map(symbol => this.toRelatedSymbol(seed.filePath, symbol, "same-module"));
            return this.wrapAsLoaded(siblings);
        } catch (error) {
            return this.wrapAsFailed(error);
        }
    }

    private async loadCallers(
        seed: ClusterSeed,
        depth: number,
        limit: number = MAX_CALL_RELATIONS
    ): Promise<RelatedSymbolsContainer> {
        if (!this.isCallableSymbol(seed.symbol)) {
            return this.wrapAsLoaded([]);
        }
        try {
            const absPath = this.resolveAbsolutePath(seed.filePath);
            const graph = await this.callGraphBuilder.analyzeSymbol(seed.symbol.name, absPath, "upstream", depth);
            if (!graph) {
                return this.wrapAsLoaded([]);
            }
            const related = this.extractRelatedFromCallGraph(graph, "called-by");
            return this.wrapWithLimit(related, limit);
        } catch (error) {
            return this.wrapAsFailed(error);
        }
    }

    private async loadCallees(
        seed: ClusterSeed,
        depth: number,
        limit: number = MAX_CALL_RELATIONS
    ): Promise<RelatedSymbolsContainer> {
        if (!this.isCallableSymbol(seed.symbol)) {
            return this.wrapAsLoaded([]);
        }
        try {
            const absPath = this.resolveAbsolutePath(seed.filePath);
            const graph = await this.callGraphBuilder.analyzeSymbol(seed.symbol.name, absPath, "downstream", depth);
            if (!graph) {
                return this.wrapAsLoaded([]);
            }
            const related = this.extractRelatedFromCallGraph(graph, "calls");
            return this.wrapWithLimit(related, limit);
        } catch (error) {
            return this.wrapAsFailed(error);
        }
    }

    private async loadTypeFamily(
        seed: ClusterSeed,
        depth: number,
        limit: number = MAX_TYPE_RELATIONS
    ): Promise<RelatedSymbolsContainer> {
        if (!this.isTypeSymbol(seed.symbol)) {
            return this.wrapAsLoaded([]);
        }
        try {
            const absPath = this.resolveAbsolutePath(seed.filePath);
            const graph = await this.typeDependencyTracker.analyzeType(seed.symbol.name, absPath, "both", depth);
            if (!graph) {
                return this.wrapAsLoaded([]);
            }
            const related = this.extractRelatedFromTypeGraph(graph);
            return this.wrapWithLimit(related, limit);
        } catch (error) {
            return this.wrapAsFailed(error);
        }
    }

    private wrapWithLimit(data: RelatedSymbol[], limit: number): RelatedSymbolsContainer {
        if (data.length > limit) {
            return {
                state: ExpansionState.TRUNCATED,
                data: data.slice(0, limit),
                totalCount: data.length,
                loadedAt: this.now()
            };
        }
        return this.wrapAsLoaded(data);
    }

    private wrapAsLoaded(data: RelatedSymbol[]): RelatedSymbolsContainer {
        return {
            state: ExpansionState.LOADED,
            data,
            loadedAt: this.now()
        };
    }

    private wrapAsFailed(error: unknown): RelatedSymbolsContainer {
        return {
            state: ExpansionState.FAILED,
            data: [],
            error: error instanceof Error ? error.message : String(error)
        };
    }

    private extractRelatedFromCallGraph(graph: CallGraphResult, relationship: RelationshipType): RelatedSymbol[] {
        const results: RelatedSymbol[] = [];
        for (const node of Object.values(graph.visitedNodes)) {
            if (node.symbolId === graph.root.symbolId) continue;
            results.push({
                filePath: node.filePath,
                symbolName: node.symbolName,
                symbolType: node.symbolType,
                relationship,
                confidence: "definite"
            });
        }
        return results;
    }

    private extractRelatedFromTypeGraph(graph: TypeGraphResult): RelatedSymbol[] {
        const results: RelatedSymbol[] = [];
        for (const node of Object.values(graph.visitedNodes)) {
            if (node.symbolId === graph.root.symbolId) continue;
            results.push({
                filePath: node.filePath,
                symbolName: node.symbolName,
                symbolType: node.symbolType,
                relationship: this.classifyTypeRelationship(graph, node),
                confidence: "definite"
            });
        }
        return results;
    }

    private classifyTypeRelationship(graph: TypeGraphResult, node: TypeGraphNode): RelationshipType {
        const directDependency = graph.root.dependencies.find(edge => edge.toSymbolId === node.symbolId);
        if (directDependency) {
            return this.mapRelationKind(directDependency.relationKind, false);
        }
        const directParent = graph.root.parents.find(edge => edge.fromSymbolId === node.symbolId);
        if (directParent) {
            return this.mapRelationKind(directParent.relationKind, true);
        }
        return "extends";
    }

    private mapRelationKind(kind: TypeRelationKind, incoming: boolean): RelationshipType {
        if (kind === "implements") {
            return incoming ? "implemented-by" : "implements";
        }
        return incoming ? "extended-by" : "extends";
    }

    private isCallableSymbol(symbol: SymbolInfo): symbol is DefinitionSymbol {
        return symbol.type === "function" || symbol.type === "method";
    }

    private isTypeSymbol(symbol: SymbolInfo): symbol is DefinitionSymbol {
        return symbol.type === "class" || symbol.type === "interface" || symbol.type === "type_alias";
    }

    private isColocatedCandidate(symbol: SymbolInfo, seedName: string): boolean {
        return symbol.name !== seedName && symbol.type !== "import";
    }

    private toRelatedSymbol(filePath: string, symbol: SymbolInfo, relationship: RelationshipType): RelatedSymbol {
        const definition = symbol as Partial<DefinitionSymbol>;
        return {
            filePath,
            symbolName: symbol.name,
            symbolType: symbol.type,
            relationship,
            confidence: "definite",
            signature: definition.signature,
            minimalPreview: symbol.name
        };
    }

    private computeMetadata(seed: ClusterSeed, related: SearchCluster["related"]): SearchClusterMetadata {
        const counts = {
            functionChain: (related.callers.data.length || 0) + (related.callees.data.length || 0),
            typeHierarchy: related.typeFamily.data.length || 0,
            moduleBoundary: (related.colocated.data.length || 0) + (related.siblings.data.length || 0)
        };

        let clusterType: SearchClusterMetadata["clusterType"] = "mixed";
        if (counts.functionChain > counts.typeHierarchy && counts.functionChain > counts.moduleBoundary && counts.functionChain > 0) {
            clusterType = "function-chain";
        } else if (counts.typeHierarchy >= counts.functionChain && counts.typeHierarchy >= counts.moduleBoundary && counts.typeHierarchy > 0) {
            clusterType = "type-hierarchy";
        } else if (counts.moduleBoundary > 0) {
            clusterType = "module-boundary";
        }

        return {
            clusterType,
            relevanceScore: seed.matchScore,
            tokenEstimate: this.estimateTokenUsage(related),
            entryPoint: seed.filePath
        };
    }

    private estimateTokenUsage(related: SearchCluster["related"]): number {
        let total = CLUSTER_TOKEN_BUDGET.metadata + CLUSTER_TOKEN_BUDGET.seeds;

        if (this.hasData(related.callers)) total += CLUSTER_TOKEN_BUDGET.callers;
        if (this.hasData(related.callees)) total += CLUSTER_TOKEN_BUDGET.callees;
        if (this.hasData(related.typeFamily)) total += CLUSTER_TOKEN_BUDGET.typeFamily;
        if (this.hasData(related.colocated)) total += CLUSTER_TOKEN_BUDGET.colocated;
        if (this.hasData(related.siblings)) total += CLUSTER_TOKEN_BUDGET.siblings;

        return total;
    }

    private hasData(container: RelatedSymbolsContainer): boolean {
        if (!container) return false;
        if (container.state === ExpansionState.TRUNCATED) return true;
        return container.state === ExpansionState.LOADED && container.data.length > 0;
    }

    private generateClusterId(seed: ClusterSeed): string {
        const hash = createHash("sha1")
            .update(`${seed.filePath}:${seed.symbol.name}`)
            .digest("hex")
            .slice(0, 12);
        return `cluster_${hash}`;
    }

    private resolveAbsolutePath(filePath: string): string {
        return path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
    }

    private createEmptyRelated(): SearchCluster["related"] {
        return {
            callers: this.createContainer(ExpansionState.NOT_LOADED),
            callees: this.createContainer(ExpansionState.NOT_LOADED),
            typeFamily: this.createContainer(ExpansionState.NOT_LOADED),
            colocated: this.createContainer(ExpansionState.NOT_LOADED),
            siblings: this.createContainer(ExpansionState.NOT_LOADED)
        };
    }

    private createContainer(state: ExpansionState, data: RelatedSymbol[] = []): RelatedSymbolsContainer {
        return {
            state,
            data,
            loadedAt: state === ExpansionState.LOADED ? this.now() : undefined
        };
    }
}
