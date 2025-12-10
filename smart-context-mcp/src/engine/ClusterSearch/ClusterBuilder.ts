import path from "path";
import { createHash } from "crypto";
import { SymbolIndex } from "../../ast/SymbolIndex.js";
import { DefinitionSymbol, SymbolInfo } from "../../types.js";
import {
    CLUSTER_TOKEN_BUDGET,
    ClusterSeed,
    ExpansionState,
    RelatedSymbol,
    RelatedSymbolsContainer,
    SearchCluster,
    SearchClusterMetadata
} from "../../types/cluster.js";

const DEFAULT_MAX_COLOCATED = 10;
const DEFAULT_MAX_SIBLINGS = 6;

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

export class ClusterBuilder {
    constructor(
        private readonly rootPath: string,
        private readonly symbolIndex: SymbolIndex,
        private readonly now: () => number = () => Date.now()
    ) {}

    async buildCluster(seed: ClusterSeed, options: BuildClusterOptions = {}): Promise<SearchCluster> {
        const related: SearchCluster["related"] = {
            callers: this.createContainer(ExpansionState.NOT_LOADED),
            callees: this.createContainer(ExpansionState.NOT_LOADED),
            typeFamily: this.createContainer(ExpansionState.NOT_LOADED),
            colocated: this.createContainer(ExpansionState.NOT_LOADED),
            siblings: this.createContainer(ExpansionState.NOT_LOADED)
        };

        const shouldExpandColocated = options.expandRelationships?.colocated !== false;
        const shouldExpandSiblings = options.expandRelationships?.siblings !== false;

        if (shouldExpandColocated || shouldExpandSiblings) {
            await this.populateCheapRelations(seed, related, {
                colocated: shouldExpandColocated,
                siblings: shouldExpandSiblings
            });
        }

        const metadata = this.computeMetadata(seed, related);

        return {
            clusterId: this.generateClusterId(seed),
            seeds: [seed],
            related,
            metadata
        };
    }

    private async populateCheapRelations(
        seed: ClusterSeed,
        related: SearchCluster["related"],
        options: { colocated: boolean; siblings: boolean }
    ): Promise<void> {
        const absPath = this.resolveAbsolutePath(seed.filePath);
        try {
            const fileSymbols = await this.symbolIndex.getSymbolsForFile(absPath);
            const timestamp = this.now();

            if (options.colocated) {
                related.colocated = {
                    state: ExpansionState.LOADED,
                    data: fileSymbols
                        .filter(symbol => this.isColocatedCandidate(symbol, seed.symbol.name))
                        .slice(0, DEFAULT_MAX_COLOCATED)
                        .map(symbol => this.toRelatedSymbol(seed.filePath, symbol, "same-file")),
                    loadedAt: timestamp
                };
            }

            if (options.siblings) {
                const siblings = seed.symbol.container
                    ? fileSymbols.filter(symbol =>
                        symbol.container === seed.symbol.container && symbol.name !== seed.symbol.name)
                    : [];

                related.siblings = {
                    state: ExpansionState.LOADED,
                    data: siblings
                        .slice(0, DEFAULT_MAX_SIBLINGS)
                        .map(symbol => this.toRelatedSymbol(seed.filePath, symbol, "same-module")),
                    loadedAt: timestamp
                };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (options.colocated) {
                related.colocated = { state: ExpansionState.FAILED, data: [], error: message };
            }
            if (options.siblings) {
                related.siblings = { state: ExpansionState.FAILED, data: [], error: message };
            }
        }
    }

    private isColocatedCandidate(symbol: SymbolInfo, seedName: string): boolean {
        if (symbol.name === seedName) {
            return false;
        }
        return symbol.type !== "import";
    }

    private toRelatedSymbol(filePath: string, symbol: SymbolInfo, relationship: RelatedSymbol["relationship"]): RelatedSymbol {
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
        const moduleCount = (related.colocated.data?.length || 0) + (related.siblings.data?.length || 0);
        const tokenEstimate = this.estimateTokenUsage(related);

        return {
            clusterType: moduleCount > 0 ? "module-boundary" : "mixed",
            relevanceScore: seed.matchScore,
            tokenEstimate,
            entryPoint: seed.filePath
        };
    }

    private estimateTokenUsage(related: SearchCluster["related"]): number {
        let total = CLUSTER_TOKEN_BUDGET.metadata;
        total += CLUSTER_TOKEN_BUDGET.seeds;

        if (related.colocated.state === ExpansionState.LOADED && related.colocated.data.length > 0) {
            total += CLUSTER_TOKEN_BUDGET.colocated;
        }
        if (related.siblings.state === ExpansionState.LOADED && related.siblings.data.length > 0) {
            total += CLUSTER_TOKEN_BUDGET.siblings;
        }

        return total;
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

    private createContainer(state: ExpansionState, data: RelatedSymbol[] = []): RelatedSymbolsContainer {
        return {
            state,
            data,
            loadedAt: state === ExpansionState.LOADED ? this.now() : undefined
        };
    }
}
