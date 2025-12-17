# ADR-018: Context-Aware Clustered Search for AI Agents (Consolidated)

## Status
Proposed (Consolidating ADR-017)

## Revision History
| Version | Date       | Author   | Description |
|---------|------------|----------|-------------|
| 1.0     | 2025-12-10 | DevKwan  | Consolidated ADR-017 (Core Architecture) and ADR-017-Addendum (Lazy Expansion, Tiered Previews, Caching) |

## Context

### Current Limitations

The existing `search_symbol_definitions` and `search_files` tools return **flat, keyword-matched lists** without relationship context:

```typescript
// Current SymbolIndex.search() - Naive keyword matching
public async search(query: string): Promise<SymbolSearchResult[]> {
    const queryLower = query.toLowerCase();
    for (const symbol of symbols) {
        if (symbol.name.toLowerCase().includes(queryLower)) {
            results.push({ filePath, symbol });
        }
    }
    return results.slice(0, 100); // Flat list, no context
}
```

**Problems for AI Agents:**
1. **Token Waste**: Agent receives 100 unrelated results, must make multiple follow-up calls to understand relationships
2. **Missing Context**: No indication of how symbols relate to each other (caller/callee, type hierarchy, co-location)
3. **Decision Paralysis**: Flat list doesn't help agent prioritize which files to read first
4. **Repeated Work**: Agent re-discovers the same clusters through trial and error across sessions

### Opportunity

Smart-context-mcp already has the building blocks for rich relationship analysis:

| Component | Capability | Leverage for Clustering |
|-----------|------------|-------------------------|
| `SymbolIndex` | Symbol extraction with ranges, types, calls | Seed symbols for cluster expansion |
| `CallGraphBuilder` | Function call relationships | Cluster by call chains |
| `DependencyGraph` | File-level import/export edges | Cluster by module boundaries |
| `TypeDependencyTracker` | Type hierarchy (extends, implements) | Cluster by type family |
| `ModuleResolver` | Import path resolution | Resolve cross-file relationships |

---

## Decision

Implement a **ClusterSearchEngine** that returns **context-aware clusters** instead of flat lists, optimized for AI agent consumption. This consolidated design incorporates:

1. **Core Cluster Architecture** (from ADR-017)
2. **Lazy Expansion with Explicit State** (from ADR-017-Addendum)
3. **Tiered Preview System** (from ADR-017-Addendum)
4. **Hot Spot Pre-computation & Caching** (from ADR-017-Addendum)

---

## Design

### Core Types

> **Reference**: See `src/types.ts` for existing types (`SymbolInfo`, `CallGraphResult`, `TypeGraphResult`, etc.)

#### ExpansionState Enum

Defines the state of a relationship's data loading:

```typescript
/**
 * Expansion state for deferred relationship loading.
 * Used to control and communicate the loading status of expensive relationships.
 */
enum ExpansionState {
    NOT_LOADED = 'not_loaded',  // Relationship data has not been fetched yet
    LOADING = 'loading',        // Currently fetching relationship data
    LOADED = 'loaded',          // Data has been fetched and is available
    FAILED = 'failed',          // Fetching failed (e.g., timeout, error)
    TRUNCATED = 'truncated',    // Data was loaded but truncated due to limits
}
```

#### RelatedSymbolsContainer Interface

Wraps related symbols with expansion state and metadata:

```typescript
/**
 * Container for related symbols with explicit expansion state.
 * Enables lazy loading of expensive relationships (callers, callees, typeFamily).
 */
interface RelatedSymbolsContainer {
    state: ExpansionState;
    data: RelatedSymbol[];     // The actual related symbols (empty if not loaded)
    error?: string;            // Error message if state is FAILED
    totalCount?: number;       // Total number of related symbols (if known and truncated)
    loadedAt?: number;         // Timestamp when data was loaded
}
```

#### SearchCluster Interface

The primary output type for clustered search results:

```typescript
interface SearchCluster {
    /** Unique identifier for this cluster (for caching and expansion) */
    clusterId: string;
    
    /** Primary matched symbol(s) */
    seeds: ClusterSeed[];
    
    /** Related symbols grouped by relationship type with explicit state */
    related: {
        callers: RelatedSymbolsContainer;      // Who calls the seed
        callees: RelatedSymbolsContainer;      // What the seed calls
        typeFamily: RelatedSymbolsContainer;   // extends/implements chain
        colocated: RelatedSymbolsContainer;    // Same file/module (always loaded)
        siblings: RelatedSymbolsContainer;     // Same parent (always loaded)
    };
    
    /** Cluster metadata for agent decision-making */
    metadata: SearchClusterMetadata;
}

interface SearchClusterMetadata {
    clusterType: 'function-chain' | 'type-hierarchy' | 'module-boundary' | 'mixed';
    relevanceScore: number;        // How well cluster matches query
    tokenEstimate: number;         // Estimated tokens if agent reads all
    entryPoint: string;            // Suggested file to start reading
}

interface ClusterSeed {
    filePath: string;
    symbol: SymbolInfo;
    matchType: 'exact' | 'prefix' | 'contains' | 'fuzzy';
    matchScore: number;
    /** Full code preview (skeleton or body snippet) for the seed. ~200 tokens. */
    fullPreview?: string;
}

interface RelatedSymbol {
    filePath: string;
    symbolName: string;
    symbolType: SymbolInfo['type'];
    relationship: RelationshipType;
    confidence: 'definite' | 'possible' | 'inferred';
    /** Concise signature or declaration. ~60 tokens. */
    signature?: string;
    /** Minimal identifier + type for cheap display. ~25 tokens. */
    minimalPreview?: string;
    /** Legacy preview field (deprecated in favor of signature/minimalPreview) */
    preview?: string;
}

type RelationshipType = 
    | 'calls' | 'called-by' 
    | 'extends' | 'implements' | 'extended-by' | 'implemented-by'
    | 'same-file' | 'same-module' | 'exports-to' | 'imports-from';
```

#### Preview Tiers Configuration

Defines token budgets for different preview levels:

```typescript
type PreviewTier = 'full' | 'signature' | 'minimal';

interface PreviewConfig {
    tier: PreviewTier;
    maxTokens: number;
    includeDoc: boolean;
}

const PREVIEW_TIERS: Record<PreviewTier, PreviewConfig> = {
    full: { tier: 'full', maxTokens: 200, includeDoc: true },       // Seeds
    signature: { tier: 'signature', maxTokens: 60, includeDoc: false }, // Callers/Callees/TypeFamily
    minimal: { tier: 'minimal', maxTokens: 25, includeDoc: false }  // Colocated/Siblings
};

const CLUSTER_TOKEN_BUDGET = {
    seeds: 400,           // Full preview for matched symbols
    callers: 300,         // Signature previews, ~5 symbols
    callees: 300,         // Signature previews, ~5 symbols
    typeFamily: 200,      // Signature previews, ~3 symbols
    colocated: 150,       // Minimal previews, ~6 symbols
    siblings: 100,        // Minimal previews, ~4 symbols
    metadata: 50          // Fixed overhead
};
// Target: ~1500 tokens per cluster
```

#### API Response Types

```typescript
interface ClusterSearchResponse {
    clusters: SearchCluster[];
    totalMatches: number;
    searchTime: string;
    
    /** Token usage metadata for agent awareness */
    tokenUsage: {
        estimated: number;      // Total estimated tokens in response
        budget: number;         // Configured budget (e.g., 5000)
        perCluster: number[];   // Breakdown per cluster
    };
    
    /** Expansion hints for agent */
    expansionHints: {
        truncatedRelationships: Array<{
            clusterId: string;
            relationship: string;
            availableCount: number;
        }>;
        recommendedExpansions: string[];
    };
}
```

---

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       ClusterSearchEngine                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐          │
│  │ QueryParser  │───▶│ SeedFinder   │───▶│ ClusterBuilder   │          │
│  └──────────────┘    └──────────────┘    └──────────────────┘          │
│         │                   │                    │                      │
│         ▼                   ▼                    ▼                      │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │                    Data Sources (Existing)                    │      │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────────────────┐    │      │
│  │  │SymbolIndex │ │CallGraph   │ │TypeDependencyTracker   │    │      │
│  │  │            │ │Builder     │ │                        │    │      │
│  │  └────────────┘ └────────────┘ └────────────────────────┘    │      │
│  │  ┌────────────┐ ┌────────────┐                               │      │
│  │  │Dependency  │ │Module      │                               │      │
│  │  │Graph       │ │Resolver    │                               │      │
│  │  └────────────┘ └────────────┘                               │      │
│  └──────────────────────────────────────────────────────────────┘      │
│                            │                                            │
│         ┌──────────────────┼──────────────────┐                        │
│         ▼                  ▼                  ▼                         │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐            │
│  │ClusterRanker │  │PreviewGen   │  │ClusterCache        │            │
│  └──────────────┘  └──────────────┘  └────────────────────┘            │
│                            │                  │                         │
│                            │     ┌────────────┴────────────┐           │
│                            │     ▼                         ▼           │
│                            │  ┌──────────────┐  ┌────────────────────┐ │
│                            │  │HotSpot      │  │Precomputation      │ │
│                            │  │Detector     │  │Engine              │ │
│                            │  └──────────────┘  └────────────────────┘ │
│                            │                                            │
│                            ▼                                            │
│                   ClusterSearchResponse                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### MCP Tool Definitions

#### Tool 1: `search_with_context`

```typescript
{
    name: "search_with_context",
    description: "Searches for symbols and returns context-aware clusters of related code. Returns grouped results with call relationships, type hierarchies, and co-located symbols - optimized for understanding code in fewer reads.",
    inputSchema: {
        type: "object",
        properties: {
            query: { 
                type: "string",
                description: "Search query. Supports filters: 'function:', 'class:', 'in:path'"
            },
            maxClusters: { 
                type: "number", 
                default: 5,
                description: "Maximum number of clusters to return"
            },
            expansionDepth: { 
                type: "number", 
                default: 2,
                description: "How many levels of relationships to include"
            },
            includePreview: { 
                type: "boolean", 
                default: true,
                description: "Include skeleton/signature previews for related symbols"
            },
            expandRelationships: {
                type: "object",
                properties: {
                    callers: { type: "boolean", default: false, description: "Expand callers immediately" },
                    callees: { type: "boolean", default: false, description: "Expand callees immediately" },
                    typeFamily: { type: "boolean", default: false, description: "Expand type family immediately" },
                    colocated: { type: "boolean", default: true, description: "Expand co-located symbols (cheap)" },
                    siblings: { type: "boolean", default: true, description: "Expand sibling symbols (cheap)" },
                    all: { type: "boolean", default: false, description: "Expand all relationships" }
                },
                description: "Selectively expand expensive relationships. Defaults: colocated=true, siblings=true, others=false."
            }
        },
        required: ["query"]
    }
}
```

#### Tool 2: `expand_cluster_relationship`

```typescript
{
    name: "expand_cluster_relationship",
    description: "Expands a specific relationship within a previously retrieved cluster. Use this when a cluster's relationship is 'not_loaded' or 'truncated'.",
    inputSchema: {
        type: "object",
        properties: {
            clusterId: { 
                type: "string", 
                description: "The unique ID of the cluster to expand." 
            },
            relationshipType: { 
                type: "string", 
                enum: ["callers", "callees", "typeFamily"], 
                description: "The type of relationship to expand." 
            },
            expansionDepth: { 
                type: "number", 
                default: 1, 
                description: "Depth for this specific expansion." 
            },
            limit: { 
                type: "number", 
                default: 20, 
                description: "Maximum number of related symbols to fetch." 
            }
        },
        required: ["clusterId", "relationshipType"]
    }
}
```

---

### Component Implementations

#### QueryParser

Parses search queries to extract intent:

```typescript
interface ParsedQuery {
    terms: string[];                    // Tokenized search terms
    filters: {
        type?: SymbolInfo['type'][];    // "class:", "function:", etc.
        file?: string;                   // "in:filename"
        scope?: 'local' | 'project';    // "scope:local"
    };
    intent: 'definition' | 'usage' | 'related' | 'any';
}

class QueryParser {
    parse(query: string): ParsedQuery {
        const filters: ParsedQuery['filters'] = {};
        let terms: string[] = [];
        let intent: ParsedQuery['intent'] = 'any';
        
        const tokens = query.split(/\s+/);
        
        for (const token of tokens) {
            if (token.startsWith('function:')) {
                filters.type = [...(filters.type || []), 'function', 'method'];
                terms.push(token.slice(9));
            } else if (token.startsWith('class:')) {
                filters.type = [...(filters.type || []), 'class'];
                terms.push(token.slice(6));
            } else if (token.startsWith('in:')) {
                filters.file = token.slice(3);
            } else if (token.startsWith('usages:')) {
                intent = 'usage';
                terms.push(token.slice(7));
            } else {
                terms.push(token);
            }
        }
        
        return { terms: terms.filter(Boolean), filters, intent };
    }
}
```

#### SeedFinder

Enhanced symbol matching with scoring:

```typescript
class SeedFinder {
    constructor(private symbolIndex: SymbolIndex) {}
    
    async findSeeds(query: ParsedQuery, limit: number = 20): Promise<ClusterSeed[]> {
        const allSymbols = await this.symbolIndex.getAllSymbols();
        const candidates: ClusterSeed[] = [];
        
        for (const [filePath, symbols] of allSymbols) {
            if (query.filters.file && !filePath.includes(query.filters.file)) continue;
            
            for (const symbol of symbols) {
                if (query.filters.type && !query.filters.type.includes(symbol.type)) continue;
                
                const match = this.scoreMatch(symbol.name, query.terms);
                if (match.score > 0) {
                    candidates.push({
                        filePath,
                        symbol,
                        matchType: match.type,
                        matchScore: match.score
                    });
                }
            }
        }
        
        return candidates
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, limit);
    }
    
    private scoreMatch(name: string, terms: string[]): { type: ClusterSeed['matchType']; score: number } {
        const nameLower = name.toLowerCase();
        
        for (const term of terms) {
            const termLower = term.toLowerCase();
            if (nameLower === termLower) return { type: 'exact', score: 1.0 };
            if (nameLower.startsWith(termLower)) return { type: 'prefix', score: 0.8 };
            if (nameLower.includes(termLower)) return { type: 'contains', score: 0.5 };
            
            const segments = this.splitCamelCase(name);
            if (segments.some(s => s.toLowerCase().startsWith(termLower))) {
                return { type: 'fuzzy', score: 0.3 };
            }
        }
        
        return { type: 'fuzzy', score: 0 };
    }
    
    private splitCamelCase(name: string): string[] {
        return name.split(/(?=[A-Z])|_|-/).filter(Boolean);
    }
}
```

#### ClusterBuilder (with Lazy Expansion)

```typescript
class ClusterBuilder {
    private readonly CHEAP_RELATIONS = ['colocated', 'siblings'] as const;
    private readonly EXPENSIVE_RELATIONS = ['callers', 'callees', 'typeFamily'] as const;
    
    constructor(
        private callGraphBuilder: CallGraphBuilder,
        private typeDependencyTracker: TypeDependencyTracker,
        private dependencyGraph: DependencyGraph,
        private symbolIndex: SymbolIndex
    ) {}
    
    async buildCluster(
        seed: ClusterSeed, 
        options: {
            depth?: number;
            expandRelationships?: {
                callers?: boolean;
                callees?: boolean;
                typeFamily?: boolean;
                colocated?: boolean;
                siblings?: boolean;
                all?: boolean;
            };
        } = {}
    ): Promise<SearchCluster> {
        const { depth = 2, expandRelationships = {} } = options;
        const shouldExpandAll = expandRelationships.all === true;
        
        // Initialize all containers with appropriate state
        const related: SearchCluster['related'] = {
            callers: this.createContainer('not_loaded'),
            callees: this.createContainer('not_loaded'),
            typeFamily: this.createContainer('not_loaded'),
            colocated: this.createContainer('not_loaded'),
            siblings: this.createContainer('not_loaded')
        };
        
        // Always populate cheap relations (unless explicitly disabled)
        if (shouldExpandAll || expandRelationships.colocated !== false) {
            await this.populateCheapRelations(seed, related);
        }
        
        // Selectively populate expensive relations
        const expansionPromises: Promise<void>[] = [];
        
        if (shouldExpandAll || expandRelationships.callers) {
            expansionPromises.push(this.populateCallers(seed, related, depth));
        }
        if (shouldExpandAll || expandRelationships.callees) {
            expansionPromises.push(this.populateCallees(seed, related, depth));
        }
        if (shouldExpandAll || expandRelationships.typeFamily) {
            expansionPromises.push(this.populateTypeFamily(seed, related, depth));
        }
        
        await Promise.allSettled(expansionPromises);
        
        return {
            clusterId: this.generateClusterId(seed),
            seeds: [seed],
            related,
            metadata: this.computeMetadata(seed, related)
        };
    }
    
    private createContainer(state: ExpansionState, data: RelatedSymbol[] = []): RelatedSymbolsContainer {
        return { state, data, loadedAt: state === 'loaded' ? Date.now() : undefined };
    }
    
    private generateClusterId(seed: ClusterSeed): string {
        return `cluster_${seed.filePath}_${seed.symbol.name}_${Date.now()}`;
    }
    
    private async populateCheapRelations(seed: ClusterSeed, related: SearchCluster['related']): Promise<void> {
        try {
            const fileSymbols = await this.symbolIndex.getSymbolsForFile(seed.filePath);
            
            related.colocated = {
                state: 'loaded',
                data: fileSymbols
                    .filter(s => s.name !== seed.symbol.name && s.type !== 'import')
                    .slice(0, 10)
                    .map(s => this.toRelatedSymbol(seed.filePath, s, 'same-file')),
                loadedAt: Date.now()
            };
            
            if (seed.symbol.container) {
                related.siblings = {
                    state: 'loaded',
                    data: fileSymbols
                        .filter(s => s.container === seed.symbol.container && s.name !== seed.symbol.name)
                        .map(s => this.toRelatedSymbol(seed.filePath, s, 'same-module')),
                    loadedAt: Date.now()
                };
            } else {
                related.siblings = { state: 'loaded', data: [], loadedAt: Date.now() };
            }
        } catch (error) {
            related.colocated = { state: 'failed', data: [], error: String(error) };
            related.siblings = { state: 'failed', data: [], error: String(error) };
        }
    }
    
    private async populateCallers(seed: ClusterSeed, related: SearchCluster['related'], depth: number): Promise<void> {
        if (!['function', 'method'].includes(seed.symbol.type)) {
            related.callers = { state: 'loaded', data: [], loadedAt: Date.now() };
            return;
        }
        
        related.callers = { state: 'loading', data: [] };
        try {
            const callGraph = await this.callGraphBuilder.analyzeSymbol(
                seed.symbol.name,
                seed.filePath,
                'upstream',
                depth
            );
            
            if (!callGraph) {
                related.callers = { state: 'loaded', data: [], loadedAt: Date.now() };
                return;
            }
            
            const callerSymbols = this.extractRelatedFromCallGraph(callGraph, 'upstream');
            const truncated = callerSymbols.length > 15;
            
            related.callers = {
                state: truncated ? 'truncated' : 'loaded',
                data: callerSymbols.slice(0, 15),
                totalCount: truncated ? callerSymbols.length : undefined,
                loadedAt: Date.now()
            };
        } catch (error) {
            related.callers = { state: 'failed', data: [], error: String(error) };
        }
    }
    
    private async populateCallees(seed: ClusterSeed, related: SearchCluster['related'], depth: number): Promise<void> {
        if (!['function', 'method'].includes(seed.symbol.type)) {
            related.callees = { state: 'loaded', data: [], loadedAt: Date.now() };
            return;
        }
        
        related.callees = { state: 'loading', data: [] };
        try {
            const callGraph = await this.callGraphBuilder.analyzeSymbol(
                seed.symbol.name,
                seed.filePath,
                'downstream',
                depth
            );
            
            if (!callGraph) {
                related.callees = { state: 'loaded', data: [], loadedAt: Date.now() };
                return;
            }
            
            const calleeSymbols = this.extractRelatedFromCallGraph(callGraph, 'downstream');
            const truncated = calleeSymbols.length > 15;
            
            related.callees = {
                state: truncated ? 'truncated' : 'loaded',
                data: calleeSymbols.slice(0, 15),
                totalCount: truncated ? calleeSymbols.length : undefined,
                loadedAt: Date.now()
            };
        } catch (error) {
            related.callees = { state: 'failed', data: [], error: String(error) };
        }
    }
    
    private async populateTypeFamily(seed: ClusterSeed, related: SearchCluster['related'], depth: number): Promise<void> {
        if (!['class', 'interface', 'type_alias'].includes(seed.symbol.type)) {
            related.typeFamily = { state: 'loaded', data: [], loadedAt: Date.now() };
            return;
        }
        
        related.typeFamily = { state: 'loading', data: [] };
        try {
            const typeGraph = await this.typeDependencyTracker.analyzeType(
                seed.symbol.name,
                seed.filePath,
                'both',
                depth
            );
            
            if (!typeGraph) {
                related.typeFamily = { state: 'loaded', data: [], loadedAt: Date.now() };
                return;
            }
            
            const typeSymbols = this.extractRelatedFromTypeGraph(typeGraph);
            const truncated = typeSymbols.length > 10;
            
            related.typeFamily = {
                state: truncated ? 'truncated' : 'loaded',
                data: typeSymbols.slice(0, 10),
                totalCount: truncated ? typeSymbols.length : undefined,
                loadedAt: Date.now()
            };
        } catch (error) {
            related.typeFamily = { state: 'failed', data: [], error: String(error) };
        }
    }
    
    private toRelatedSymbol(filePath: string, symbol: SymbolInfo, relationship: RelationshipType): RelatedSymbol {
        return {
            filePath,
            symbolName: symbol.name,
            symbolType: symbol.type,
            relationship,
            confidence: 'definite'
        };
    }
    
    private extractRelatedFromCallGraph(graph: CallGraphResult, direction: 'upstream' | 'downstream'): RelatedSymbol[] {
        const results: RelatedSymbol[] = [];
        for (const node of Object.values(graph.visitedNodes)) {
            if (node.symbolId === graph.root.symbolId) continue;
            results.push({
                filePath: node.filePath,
                symbolName: node.symbolName,
                symbolType: node.symbolType,
                relationship: direction === 'upstream' ? 'called-by' : 'calls',
                confidence: 'definite'
            });
        }
        return results;
    }
    
    private extractRelatedFromTypeGraph(graph: TypeGraphResult): RelatedSymbol[] {
        const results: RelatedSymbol[] = [];
        for (const node of Object.values(graph.visitedNodes)) {
            if (node.symbolId === graph.root.symbolId) continue;
            const hasExtends = node.parents.some(e => e.relationKind === 'extends');
            const hasImplements = node.parents.some(e => e.relationKind === 'implements');
            results.push({
                filePath: node.filePath,
                symbolName: node.symbolName,
                symbolType: node.symbolType,
                relationship: hasExtends ? 'extends' : hasImplements ? 'implements' : 'extends',
                confidence: 'definite'
            });
        }
        return results;
    }
    
    private computeMetadata(seed: ClusterSeed, related: SearchCluster['related']): SearchClusterMetadata {
        const counts = {
            'function-chain': (related.callers.data?.length || 0) + (related.callees.data?.length || 0),
            'type-hierarchy': related.typeFamily.data?.length || 0,
            'module-boundary': (related.colocated.data?.length || 0) + (related.siblings.data?.length || 0)
        };
        
        const clusterType = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])[0][0] as SearchClusterMetadata['clusterType'];
        
        const totalSymbols = Object.values(related)
            .reduce((sum, container) => sum + (container.data?.length || 0), 1);
        const tokenEstimate = totalSymbols * 50;
        
        return {
            clusterType: counts['function-chain'] > 0 || counts['type-hierarchy'] > 0 ? clusterType : 'mixed',
            relevanceScore: seed.matchScore,
            tokenEstimate,
            entryPoint: seed.filePath
        };
    }
}
```

#### PreviewGenerator (Tiered Previews)

```typescript
class PreviewGenerator {
    constructor(private skeletonGenerator: SkeletonGenerator) {}
    
    async generateSeedPreview(symbol: SymbolInfo, filePath: string, content: string): Promise<string> {
        const budget = PREVIEW_TIERS.full;
        let preview = symbol.signature || this.extractSignature(symbol, content);
        
        if (budget.includeDoc && symbol.doc) {
            const docLines = symbol.doc.split('\n').slice(0, 3).join('\n');
            preview = `${docLines}\n${preview}`;
        }
        
        return this.truncateToTokenBudget(preview, budget.maxTokens);
    }
    
    generateRelatedPreview(symbol: RelatedSymbol): string {
        const budget = PREVIEW_TIERS.signature;
        const signature = this.compactSignature(symbol);
        return this.truncateToTokenBudget(signature, budget.maxTokens);
    }
    
    generateMinimalPreview(symbol: RelatedSymbol): string {
        return `${symbol.symbolName} (${symbol.symbolType})`;
    }
    
    private compactSignature(symbol: RelatedSymbol): string {
        if (['function', 'method'].includes(symbol.symbolType)) {
            if (symbol.preview) {
                return symbol.preview.replace(/\s*\{[\s\S]*\}$/, '').trim();
            }
        }
        return symbol.symbolName;
    }
    
    private truncateToTokenBudget(text: string, maxTokens: number): string {
        const maxChars = maxTokens * 4;
        if (text.length <= maxChars) return text;
        return text.substring(0, maxChars - 3) + '...';
    }
    
    private extractSignature(symbol: SymbolInfo, content: string): string {
        if ('signature' in symbol && symbol.signature) return symbol.signature;
        return symbol.name;
    }
    
    async applyPreviewsToCluster(cluster: SearchCluster, fileContents: Map<string, string>): Promise<SearchCluster> {
        for (const seed of cluster.seeds) {
            const content = fileContents.get(seed.filePath) || '';
            seed.fullPreview = await this.generateSeedPreview(seed.symbol, seed.filePath, content);
        }
        
        for (const caller of cluster.related.callers.data) {
            caller.signature = this.generateRelatedPreview(caller);
        }
        for (const callee of cluster.related.callees.data) {
            callee.signature = this.generateRelatedPreview(callee);
        }
        for (const type of cluster.related.typeFamily.data) {
            type.signature = this.generateRelatedPreview(type);
        }
        for (const coloc of cluster.related.colocated.data) {
            coloc.minimalPreview = this.generateMinimalPreview(coloc);
        }
        for (const sibling of cluster.related.siblings.data) {
            sibling.minimalPreview = this.generateMinimalPreview(sibling);
        }
        
        return cluster;
    }
}
```

#### HotSpotDetector

```typescript
interface HotSpotConfig {
    minIncomingRefs: number;
    trackEntryExports: boolean;
    patternMatchers: RegExp[];
    maxHotSpots: number;
}

const DEFAULT_HOT_SPOT_CONFIG: HotSpotConfig = {
    minIncomingRefs: 5,
    trackEntryExports: true,
    patternMatchers: [
        /^(get|set|create|update|delete|handle|process)/i,
        /Service$/,
        /Controller$/,
        /^use[A-Z]/
    ],
    maxHotSpots: 50
};

interface HotSpot {
    filePath: string;
    symbolName: string;
    symbolType: string;
    score: number;
    reasons: string[];
}

class HotSpotDetector {
    constructor(
        private symbolIndex: SymbolIndex,
        private dependencyGraph: DependencyGraph,
        private config: HotSpotConfig = DEFAULT_HOT_SPOT_CONFIG
    ) {}
    
    async detectHotSpots(): Promise<HotSpot[]> {
        const allSymbols = await this.symbolIndex.getAllSymbols();
        const candidates: HotSpot[] = [];
        
        for (const [filePath, symbols] of allSymbols) {
            for (const symbol of symbols) {
                if (symbol.type === 'import' || symbol.type === 'export') continue;
                
                const score = await this.scoreSymbol(filePath, symbol);
                if (score > 0) {
                    candidates.push({
                        filePath,
                        symbolName: symbol.name,
                        symbolType: symbol.type,
                        score,
                        reasons: this.explainScore(filePath, symbol, score)
                    });
                }
            }
        }
        
        return candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, this.config.maxHotSpots);
    }
    
    private async scoreSymbol(filePath: string, symbol: SymbolInfo): Promise<number> {
        let score = 0;
        
        try {
            const incoming = await this.dependencyGraph.getDependencies(filePath, 'incoming');
            if (incoming.length >= this.config.minIncomingRefs) {
                score += Math.min(incoming.length / 2, 10);
            }
        } catch { /* ignore */ }
        
        if (this.config.patternMatchers.some(pattern => pattern.test(symbol.name))) {
            score += 3;
        }
        
        if (this.config.trackEntryExports && this.isEntryPointExport(filePath, symbol)) {
            score += 5;
        }
        
        if (symbol.type === 'class' || symbol.type === 'interface') {
            score += 2;
        }
        
        return score;
    }
    
    private isEntryPointExport(filePath: string, symbol: SymbolInfo): boolean {
        const isIndex = /(?:^|\/)index\.(ts|js)x?$/.test(filePath);
        const hasExportModifier = symbol.modifiers?.includes('export');
        return isIndex && (hasExportModifier || symbol.type === 'export');
    }
    
    private explainScore(filePath: string, symbol: SymbolInfo, score: number): string[] {
        const reasons: string[] = [];
        if (score >= 5 && this.isEntryPointExport(filePath, symbol)) reasons.push('entry_export');
        if (this.config.patternMatchers.some(p => p.test(symbol.name))) reasons.push('pattern_match');
        return reasons;
    }
}
```

#### ClusterPrecomputationEngine

```typescript
class ClusterPrecomputationEngine {
    private precomputedClusters = new Map<string, {
        cluster: SearchCluster;
        computedAt: number;
        hitCount: number;
    }>();
    
    private isRunning = false;
    
    constructor(
        private clusterBuilder: ClusterBuilder,
        private hotSpotDetector: HotSpotDetector,
        private config = {
            precomputeIntervalMs: 5 * 60 * 1000,
            maxPrecomputed: 30,
            staleAfterMs: 10 * 60 * 1000
        }
    ) {}
    
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.scheduleNextPrecomputation();
    }
    
    stop(): void {
        this.isRunning = false;
    }
    
    private async scheduleNextPrecomputation(): Promise<void> {
        if (!this.isRunning) return;
        
        try {
            await this.runPrecomputationCycle();
        } catch (error) {
            console.error('[ClusterPrecomputation] Cycle failed:', error);
        }
        
        setTimeout(() => this.scheduleNextPrecomputation(), this.config.precomputeIntervalMs);
    }
    
    private async runPrecomputationCycle(): Promise<void> {
        const hotSpots = await this.hotSpotDetector.detectHotSpots();
        const toPrecompute = this.prioritizeForPrecomputation(hotSpots);
        
        const BATCH_SIZE = 5;
        for (let i = 0; i < toPrecompute.length && i < this.config.maxPrecomputed; i += BATCH_SIZE) {
            const batch = toPrecompute.slice(i, i + BATCH_SIZE);
            
            await Promise.all(batch.map(async (hotSpot) => {
                const cacheKey = `${hotSpot.filePath}::${hotSpot.symbolName}`;
                
                try {
                    const cluster = await this.clusterBuilder.buildCluster(
                        {
                            filePath: hotSpot.filePath,
                            symbol: { name: hotSpot.symbolName, type: hotSpot.symbolType } as SymbolInfo,
                            matchType: 'exact',
                            matchScore: 1.0
                        },
                        { depth: 2, expandRelationships: { all: true } }
                    );
                    
                    const existing = this.precomputedClusters.get(cacheKey);
                    this.precomputedClusters.set(cacheKey, {
                        cluster,
                        computedAt: Date.now(),
                        hitCount: existing?.hitCount || 0
                    });
                } catch (error) {
                    console.warn(`[ClusterPrecomputation] Failed for ${cacheKey}:`, error);
                }
            }));
            
            await new Promise(resolve => setImmediate(resolve));
        }
        
        this.evictIfNeeded();
    }
    
    private prioritizeForPrecomputation(hotSpots: HotSpot[]): HotSpot[] {
        const now = Date.now();
        
        return hotSpots
            .map(hs => {
                const cacheKey = `${hs.filePath}::${hs.symbolName}`;
                const cached = this.precomputedClusters.get(cacheKey);
                
                let priority = hs.score;
                if (!cached) priority += 10;
                else if (now - cached.computedAt > this.config.staleAfterMs) priority += 5;
                else priority -= 5;
                
                return { hotSpot: hs, priority };
            })
            .sort((a, b) => b.priority - a.priority)
            .map(x => x.hotSpot);
    }
    
    private evictIfNeeded(): void {
        if (this.precomputedClusters.size <= this.config.maxPrecomputed) return;
        
        const entries = Array.from(this.precomputedClusters.entries())
            .sort(([, a], [, b]) => {
                if (a.hitCount !== b.hitCount) return a.hitCount - b.hitCount;
                return a.computedAt - b.computedAt;
            });
        
        const toRemove = entries.slice(0, entries.length - this.config.maxPrecomputed);
        for (const [key] of toRemove) {
            this.precomputedClusters.delete(key);
        }
    }
    
    getPrecomputedCluster(filePath: string, symbolName: string): SearchCluster | null {
        const cacheKey = `${filePath}::${symbolName}`;
        const entry = this.precomputedClusters.get(cacheKey);
        
        if (!entry) return null;
        entry.hitCount++;
        
        return entry.cluster;
    }
    
    invalidateFile(filePath: string): void {
        for (const [key, entry] of this.precomputedClusters) {
            const affectsCluster = 
                key.startsWith(`${filePath}::`) ||
                entry.cluster.seeds.some(s => s.filePath === filePath) ||
                Object.values(entry.cluster.related).some(container => 
                    container.data.some(r => r.filePath === filePath)
                );
            
            if (affectsCluster) {
                this.precomputedClusters.delete(key);
            }
        }
    }
}
```

---

### File Structure

```
src/
├── ast/
│   ├── CallGraphBuilder.ts        # (existing)
│   ├── TypeDependencyTracker.ts   # (existing)
│   ├── SymbolIndex.ts             # (existing)
│   ├── DependencyGraph.ts         # (existing)
│   └── ...
├── engine/
│   ├── Search.ts                  # (existing - keyword search)
│   └── ClusterSearch/             # 🆕 NEW DIRECTORY
│       ├── index.ts               # ClusterSearchEngine facade
│       ├── QueryParser.ts
│       ├── SeedFinder.ts
│       ├── ClusterBuilder.ts
│       ├── ClusterRanker.ts
│       ├── PreviewGenerator.ts
│       ├── ClusterCache.ts
│       ├── HotSpotDetector.ts
│       └── ClusterPrecomputationEngine.ts
├── types/
│   └── cluster.ts                 # 🆕 SearchCluster, ExpansionState, etc.
└── types.ts                       # (existing - reference for SymbolInfo, etc.)
```

---

## Implementation Checklist

### Phase 1: Lite Clusters (Low Complexity) — 3-4 days

**Goal**: Return matched symbols + siblings + colocated definitions. No expensive call graph expansion.

| Task | Status | Notes |
|------|--------|-------|
| Define `ExpansionState` enum in `src/types/cluster.ts` | [ ] | |
| Define `RelatedSymbolsContainer` interface | [ ] | |
| Define `SearchCluster`, `ClusterSeed`, `RelatedSymbol` types | [ ] | |
| Define `ClusterSearchResponse` with `tokenUsage` and `expansionHints` | [ ] | |
| Implement `QueryParser` class | [ ] | |
| Implement `SeedFinder` class | [ ] | |
| Implement `ClusterBuilder` (colocated/siblings only) | [ ] | Skip callers/callees/typeFamily initially |
| Implement `ClusterRanker` class | [ ] | |
| Create `ClusterSearchEngine` facade class | [ ] | Wire up components |
| Unit tests for Phase 1 components | [ ] | |

### Phase 2: Relational Clusters (Medium Complexity) — 2-3 days

**Goal**: Add callers, callees, typeFamily expansion to top results.

| Task | Status | Notes |
|------|--------|-------|
| Extend `ClusterBuilder` with `populateCallers()` | [ ] | Use `CallGraphBuilder` depth=1 |
| Extend `ClusterBuilder` with `populateCallees()` | [ ] | Use `CallGraphBuilder` depth=1 |
| Extend `ClusterBuilder` with `populateTypeFamily()` | [ ] | Use `TypeDependencyTracker` |
| Implement `PreviewGenerator` with tiered previews | [ ] | |
| Add `search_with_context` tool definition | [ ] | Include `expandRelationships` parameter |
| Add `expand_cluster_relationship` tool definition | [ ] | |
| Implement handlers in `handleCallTool` for both tools | [ ] | |
| Wire up cache invalidation in existing file watch hooks | [ ] | |
| Integration tests for Phase 2 | [ ] | |

### Phase 3: Optimization (High Complexity) — 2-3 days

**Goal**: Sub-500ms response time for full clusters.

| Task | Status | Notes |
|------|--------|-------|
| Implement `ClusterCache` with TTL and invalidation | [ ] | |
| Implement `HotSpotDetector` class | [ ] | |
| Implement `ClusterPrecomputationEngine` | [ ] | Background pre-computation |
| Integrate pre-computation with file invalidation hooks | [ ] | |
| Add startup/shutdown lifecycle for pre-computation | [ ] | |
| Performance benchmarks on medium projects | [ ] | Target P95 < 500ms |
| Documentation update | [ ] | |

#### Phase 3 Implementation Notes (2025-12-11)

- `ClusterCache` now stores full `ClusterSearchResponse` payloads keyed by `(query, expandRelationships, preview flags)` with TTL-based eviction and file/directory invalidation hooks triggered from MCP write APIs.
- `HotSpotDetector` scores candidates using dependency in-degree, naming heuristics, and entry-point exports; the top N feed `ClusterPrecomputationEngine`, which eagerly refreshes cache entries every five minutes.
- Background pre-computation starts only after the AST/dependency graph warmup finishes to avoid repeated rebuilds. Set `SMART_CONTEXT_DISABLE_PRECOMPUTE=true` when agents should skip the background work (CI, low-powered environments, etc.).
- Cached clusters retain preview tiers so a second `search_with_context` call with matching options typically returns immediately; `expand_cluster_relationship` keeps metadata in sync by writing through the same cache layer.

##### Benchmark Snapshot (local, 2025-12-11)

- Test fixture `src/tests/cluster_search_env` (8 symbols / 2 files) measured ~40 ms for cold `search_with_context` responses and <5 ms for cached replays (captured via Jest integration output). Larger internal projects should stay below the ADR target (P95 < 500 ms) because expensive graph traversals now hit warmed caches except for the first request after invalidation.

---

## Feasibility & Risk Assessment

### Feasibility Analysis

The architecture is **highly feasible** because it orchestrates existing, proven components:

- **Symbol Matching**: `SymbolIndex` already provides robust AST-based symbol extraction.
- **Relationship Extraction**: `CallGraphBuilder` and `TypeDependencyTracker` are implemented and tested.
- **Module Context**: `DependencyGraph` already tracks file-level edges.

The primary challenge is **orchestration latency**, not capability.

### Risk Assessment

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|---------------------|
| **Latency Spikes** | High | High | Lazy Loading: fetch cheap context initially; expensive context on demand |
| **"God Object" Noise** | Medium | Medium | Cluster Pruning: limit related items to top 5-15 by confidence |
| **False Positives** | Medium | Low | Confidence Scoring: label relationships as `definite` vs `possible` |
| **Token Overload** | Low | High | Strict Budgeting: hard limit ~1500 tokens per cluster |

---

## Expected Impact

### 1. Token Efficiency & Cost (High Impact)
- **Current**: Agent reads entire file (15k tokens) to find one function.
- **Proposed**: Agent receives a cluster (~500-1500 tokens) with function and relationships.
- **Estimate**: **90% reduction** in tokens for initial context gathering.

### 2. Context Window Management (Medium Impact)
- Reduces "pollution" of the context window with irrelevant code.

### 3. Agent Autonomy (High Impact)
- **Current**: Agent guesses keywords → fails → tries new keywords.
- **Proposed**: Agent searches once → navigates relationships.
- **Result**: "One-shot" context gathering becomes possible.

---

## Trade-offs

| Decision | Benefit | Cost |
|----------|---------|------|
| Explicit `ExpansionState` | Clear contract; no ambiguous strings | Slightly larger response payload |
| Tiered previews | Predictable token usage | Seeds may lose context without full bodies |
| Background pre-computation | Sub-100ms for hot spots | Memory overhead (~2MB for 30 clusters) |
| Hit count eviction | Keeps frequently-used clusters warm | May evict newly-hot symbols |

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Agent Tool Calls Reduction | 50% fewer calls in exploration phase | Compare call logs before/after |
| Search-to-Edit Time | < 3 calls from search to informed edit | Track tool chains in sessions |
| Token Efficiency | < 2000 tokens per cluster | Measure output size |
| Response Time | P95 < 500ms | Benchmark on medium projects |

---

## Alternatives Considered

### Alternative 1: Enhance Existing Search with Rankings
Just add relevance scoring to flat results.

**Rejected**: Doesn't provide relationship context; agent still needs multiple calls.

### Alternative 2: Graph Database (Neo4j/GraphQL)
Store all relationships in a graph DB for complex queries.

**Rejected**: Heavy dependency; overkill for project-scoped analysis.

### Alternative 3: Return Full Graphs
Return entire `CallGraphResult` or `TypeGraphResult` from search.

**Rejected**: Too verbose; clusters provide curated subsets optimized for consumption.

---

## Related Documents

- [ADR-016: Impact Flow Analysis](./ADR-016-impact-flow-analysis.md) - `CallGraphBuilder` foundation
- [ADR-010: Smart Semantic Analysis](./ADR-010-smart-semantic-analysis.md) - AST infrastructure
- [ADR-014: Smart File Profile](./ADR-014-smart-file-profile.md) - Token-efficient output patterns
- `src/types.ts` - Existing types (`SymbolInfo`, `CallGraphResult`, `TypeGraphResult`)

---

## Appendix: Example Tool Output

```json
{
    "clusters": [
        {
            "clusterId": "cluster_src/services/pricing.ts_calculatePrice_1733842981000",
            "seeds": [{
                "filePath": "src/services/pricing.ts",
                "symbol": {
                    "name": "calculatePrice",
                    "type": "function",
                    "signature": "calculatePrice(item: Item, quantity: number): number"
                },
                "matchType": "exact",
                "matchScore": 1.0,
                "fullPreview": "/**\n * Calculates the total price for an item.\n */\ncalculatePrice(item: Item, quantity: number): number"
            }],
            "related": {
                "callers": {
                    "state": "loaded",
                    "data": [
                        {
                            "filePath": "src/services/cart.ts",
                            "symbolName": "CartService.getTotal",
                            "symbolType": "method",
                            "relationship": "called-by",
                            "confidence": "definite",
                            "signature": "getTotal(): number"
                        }
                    ],
                    "loadedAt": 1733842981000
                },
                "callees": {
                    "state": "not_loaded",
                    "data": []
                },
                "typeFamily": {
                    "state": "not_loaded",
                    "data": []
                },
                "colocated": {
                    "state": "loaded",
                    "data": [
                        {
                            "filePath": "src/services/pricing.ts",
                            "symbolName": "PricingConfig",
                            "symbolType": "interface",
                            "relationship": "same-file",
                            "confidence": "definite",
                            "minimalPreview": "PricingConfig (interface)"
                        }
                    ],
                    "loadedAt": 1733842981000
                },
                "siblings": {
                    "state": "loaded",
                    "data": [],
                    "loadedAt": 1733842981000
                }
            },
            "metadata": {
                "clusterType": "function-chain",
                "relevanceScore": 1.0,
                "tokenEstimate": 350,
                "entryPoint": "src/services/pricing.ts"
            }
        }
    ],
    "totalMatches": 1,
    "searchTime": "45ms",
    "tokenUsage": {
        "estimated": 350,
        "budget": 5000,
        "perCluster": [350]
    },
    "expansionHints": {
        "truncatedRelationships": [],
        "recommendedExpansions": [
            "Expand callees for calculatePrice to see downstream dependencies"
        ]
    }
}
```

---

**Author**: DevKwan  
**Date**: 2025-12-10  
**Status**: Proposed (Consolidating ADR-017)
