import { SymbolInfo } from "../types.js";

/**
 * Expansion states describe whether an expensive relationship has been
 * materialized yet. Agents rely on this metadata to decide when to make
 * follow-up expansion calls.
 */
export enum ExpansionState {
    NOT_LOADED = "not_loaded",
    LOADING = "loading",
    LOADED = "loaded",
    FAILED = "failed",
    TRUNCATED = "truncated"
}

export type PreviewTier = "full" | "signature" | "minimal";

export interface PreviewConfig {
    tier: PreviewTier;
    maxTokens: number;
    includeDoc: boolean;
}

export const PREVIEW_TIERS: Record<PreviewTier, PreviewConfig> = {
    full: { tier: "full", maxTokens: 200, includeDoc: true },
    signature: { tier: "signature", maxTokens: 60, includeDoc: false },
    minimal: { tier: "minimal", maxTokens: 25, includeDoc: false }
};

export const CLUSTER_TOKEN_BUDGET = {
    seeds: 400,
    callers: 300,
    callees: 300,
    typeFamily: 200,
    colocated: 150,
    siblings: 100,
    metadata: 50
} as const;

export type RelationshipType =
    | "calls" | "called-by"
    | "extends" | "implements" | "extended-by" | "implemented-by"
    | "same-file" | "same-module" | "exports-to" | "imports-from";

export interface RelatedSymbol {
    filePath: string;
    symbolName: string;
    symbolType: SymbolInfo["type"];
    relationship: RelationshipType;
    confidence: "definite" | "possible" | "inferred";
    signature?: string;
    minimalPreview?: string;
    /**
     * Legacy preview data kept for backward compatibility. Prefer signature
     * or minimalPreview fields for new work.
     */
    preview?: string;
}

export interface RelatedSymbolsContainer {
    state: ExpansionState;
    data: RelatedSymbol[];
    error?: string;
    totalCount?: number;
    loadedAt?: number;
}

export interface ClusterSeed {
    filePath: string;
    symbol: SymbolInfo;
    matchType: "exact" | "prefix" | "contains" | "fuzzy";
    matchScore: number;
    fullPreview?: string;
}

export interface SearchClusterMetadata {
    clusterType: "function-chain" | "type-hierarchy" | "module-boundary" | "mixed";
    relevanceScore: number;
    tokenEstimate: number;
    entryPoint: string;
}

export interface SearchCluster {
    clusterId: string;
    seeds: ClusterSeed[];
    related: {
        callers: RelatedSymbolsContainer;
        callees: RelatedSymbolsContainer;
        typeFamily: RelatedSymbolsContainer;
        colocated: RelatedSymbolsContainer;
        siblings: RelatedSymbolsContainer;
    };
    metadata: SearchClusterMetadata;
}

export interface ClusterSearchResponse {
    clusters: SearchCluster[];
    totalMatches: number;
    searchTime: string;
    tokenUsage: {
        estimated: number;
        budget: number;
        perCluster: number[];
    };
    expansionHints: {
        truncatedRelationships: Array<{
            clusterId: string;
            relationship: string;
            availableCount: number;
        }>;
        recommendedExpansions: string[];
    };
}
