# ADR-017: Context-Aware Clustered Search for AI Agents

## Status
Proposed

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

## Decision

Implement a **ClusterSearchEngine** that returns **context-aware clusters** instead of flat lists, optimized for AI agent consumption.

### Core Concept: Search Clusters

```typescript
interface SearchCluster {
    /** Primary matched symbol(s) */
    seeds: ClusterSeed[];
    
    /** Related symbols grouped by relationship type */
    related: {
        callers: RelatedSymbol[];      // Who calls the seed
        callees: RelatedSymbol[];      // What the seed calls
        typeFamily: RelatedSymbol[];   // extends/implements chain
        colocated: RelatedSymbol[];    // Same file/module
        siblings: RelatedSymbol[];     // Same parent (class methods, module exports)
    };
    
    /** Cluster metadata for agent decision-making */
    metadata: {
        clusterType: 'function-chain' | 'type-hierarchy' | 'module-boundary' | 'mixed';
        relevanceScore: number;        // How well cluster matches query
        tokenEstimate: number;         // Estimated tokens if agent reads all
        entryPoint: string;            // Suggested file to start reading
    };
}

interface ClusterSeed {
    filePath: string;
    symbol: SymbolInfo;
    matchType: 'exact' | 'prefix' | 'contains' | 'fuzzy';
    matchScore: number;
}

interface RelatedSymbol {
    filePath: string;
    symbolName: string;
    symbolType: SymbolInfo['type'];
    relationship: RelationshipType;
    confidence: 'definite' | 'possible' | 'inferred';
    /** Skeleton or signature for quick preview */
    preview?: string;
}

type RelationshipType = 
    | 'calls' | 'called-by' 
    | 'extends' | 'implements' | 'extended-by' | 'implemented-by'
    | 'same-file' | 'same-module' | 'exports-to' | 'imports-from';
```

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ClusterSearchEngine                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ QueryParser  │───▶│ SeedFinder   │───▶│ ClusterBuilder│     │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                    │              │
│         ▼                   ▼                    ▼              │
│  ┌──────────────────────────────────────────────────────┐      │
│  │                    Aggregators                        │      │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────────┐    │      │
│  │  │SymbolIndex │ │CallGraph   │ │TypeDependency  │    │      │
│  │  │            │ │Builder     │ │Tracker         │    │      │
│  │  └────────────┘ └────────────┘ └────────────────┘    │      │
│  │  ┌────────────┐ ┌────────────┐                       │      │
│  │  │Dependency  │ │Module      │                       │      │
│  │  │Graph       │ │Resolver    │                       │      │
│  │  └────────────┘ └────────────┘                       │      │
│  └──────────────────────────────────────────────────────┘      │
│                            │                                    │
│                            ▼                                    │
│                   ┌──────────────┐                              │
│                   │ClusterRanker │                              │
│                   └──────────────┘                              │
│                            │                                    │
│                            ▼                                    │
│                   SearchCluster[]                               │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Strategy

#### Phase 1: ClusterSearchEngine Core (3-4 days)

**Step 1.1: Query Parser**

Parse search queries to extract intent:

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

// Examples:
// "calculatePrice" → { terms: ["calculatePrice"], intent: "any" }
// "function:handle* in:api/" → { terms: ["handle"], filters: { type: ["function"], file: "api/" }, intent: "definition" }
// "usages:CartService" → { terms: ["CartService"], intent: "usage" }
```

**Step 1.2: Seed Finder**

Enhanced symbol matching beyond substring:

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
            
            // Exact match
            if (nameLower === termLower) return { type: 'exact', score: 1.0 };
            
            // Prefix match (camelCase aware)
            if (nameLower.startsWith(termLower)) return { type: 'prefix', score: 0.8 };
            
            // Contains match
            if (nameLower.includes(termLower)) return { type: 'contains', score: 0.5 };
            
            // Fuzzy match (camelCase segments)
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

**Step 1.3: Cluster Builder**

Expand seeds into clusters using existing analyzers:

```typescript
class ClusterBuilder {
    constructor(
        private callGraphBuilder: CallGraphBuilder,
        private typeDependencyTracker: TypeDependencyTracker,
        private dependencyGraph: DependencyGraph,
        private symbolIndex: SymbolIndex
    ) {}
    
    async buildCluster(seed: ClusterSeed, depth: number = 2): Promise<SearchCluster> {
        const related: SearchCluster['related'] = {
            callers: [],
            callees: [],
            typeFamily: [],
            colocated: [],
            siblings: []
        };
        
        // 1. Call relationships (leverage existing CallGraphBuilder)
        if (['function', 'method'].includes(seed.symbol.type)) {
            const callGraph = await this.callGraphBuilder.analyzeSymbol(
                seed.symbol.name,
                seed.filePath,
                'both',
                depth
            );
            
            if (callGraph) {
                related.callers = this.extractRelatedFromCallGraph(callGraph, 'upstream');
                related.callees = this.extractRelatedFromCallGraph(callGraph, 'downstream');
            }
        }
        
        // 2. Type hierarchy (leverage existing TypeDependencyTracker)
        if (['class', 'interface', 'type_alias'].includes(seed.symbol.type)) {
            const typeGraph = await this.typeDependencyTracker.analyzeType(
                seed.symbol.name,
                seed.filePath,
                'both',
                depth
            );
            
            if (typeGraph) {
                related.typeFamily = this.extractRelatedFromTypeGraph(typeGraph);
            }
        }
        
        // 3. Co-located symbols (same file)
        const fileSymbols = await this.symbolIndex.getSymbolsForFile(seed.filePath);
        related.colocated = fileSymbols
            .filter(s => s.name !== seed.symbol.name && s.type !== 'import')
            .slice(0, 10)
            .map(s => ({
                filePath: seed.filePath,
                symbolName: s.name,
                symbolType: s.type,
                relationship: 'same-file' as RelationshipType,
                confidence: 'definite' as const
            }));
        
        // 4. Module siblings (exported from same module)
        if (seed.symbol.container) {
            related.siblings = fileSymbols
                .filter(s => s.container === seed.symbol.container && s.name !== seed.symbol.name)
                .map(s => ({
                    filePath: seed.filePath,
                    symbolName: s.name,
                    symbolType: s.type,
                    relationship: 'same-module' as RelationshipType,
                    confidence: 'definite' as const
                }));
        }
        
        return {
            seeds: [seed],
            related,
            metadata: this.computeMetadata(seed, related)
        };
    }
    
    private computeMetadata(seed: ClusterSeed, related: SearchCluster['related']): SearchCluster['metadata'] {
        // Determine cluster type based on dominant relationship
        const counts = {
            'function-chain': related.callers.length + related.callees.length,
            'type-hierarchy': related.typeFamily.length,
            'module-boundary': related.colocated.length + related.siblings.length
        };
        
        const clusterType = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])[0][0] as SearchCluster['metadata']['clusterType'];
        
        // Estimate token usage (rough: 50 tokens per symbol preview)
        const totalSymbols = Object.values(related).flat().length + 1;
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

**Step 1.4: Cluster Ranker**

Rank and deduplicate clusters:

```typescript
class ClusterRanker {
    rank(clusters: SearchCluster[]): SearchCluster[] {
        // Score clusters by:
        // 1. Seed match quality
        // 2. Relationship density (more connections = more valuable context)
        // 3. Token efficiency (smaller clusters preferred when equally relevant)
        
        return clusters
            .map(cluster => ({
                cluster,
                score: this.scoreCluster(cluster)
            }))
            .sort((a, b) => b.score - a.score)
            .map(({ cluster }) => cluster);
    }
    
    private scoreCluster(cluster: SearchCluster): number {
        const seedScore = cluster.seeds.reduce((sum, s) => sum + s.matchScore, 0) / cluster.seeds.length;
        
        const relationshipCount = Object.values(cluster.related)
            .reduce((sum, arr) => sum + arr.length, 0);
        
        const densityScore = Math.min(relationshipCount / 20, 1); // Cap at 20 relationships
        
        const tokenPenalty = Math.max(0, 1 - cluster.metadata.tokenEstimate / 5000); // Penalize > 5000 tokens
        
        return (seedScore * 0.5) + (densityScore * 0.3) + (tokenPenalty * 0.2);
    }
}
```

#### Phase 2: MCP Tool Integration (1-2 days)

**New Tool: `search_with_context`**

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
            }
        },
        required: ["query"]
    }
}
```

**Example Output:**

```json
{
    "clusters": [
        {
            "seeds": [{
                "filePath": "src/services/pricing.ts",
                "symbol": {
                    "name": "calculatePrice",
                    "type": "function",
                    "signature": "calculatePrice(item: Item, quantity: number): number"
                },
                "matchType": "exact",
                "matchScore": 1.0
            }],
            "related": {
                "callers": [
                    {
                        "filePath": "src/services/cart.ts",
                        "symbolName": "CartService.getTotal",
                        "symbolType": "method",
                        "relationship": "called-by",
                        "confidence": "definite",
                        "preview": "getTotal(): number { ... }"
                    },
                    {
                        "filePath": "src/api/checkout.ts",
                        "symbolName": "handleCheckout",
                        "symbolType": "function",
                        "relationship": "called-by",
                        "confidence": "definite"
                    }
                ],
                "callees": [
                    {
                        "filePath": "src/utils/tax.ts",
                        "symbolName": "calculateTax",
                        "symbolType": "function",
                        "relationship": "calls",
                        "confidence": "definite"
                    }
                ],
                "typeFamily": [],
                "colocated": [
                    {
                        "filePath": "src/services/pricing.ts",
                        "symbolName": "PricingConfig",
                        "symbolType": "interface",
                        "relationship": "same-file",
                        "confidence": "definite"
                    }
                ],
                "siblings": []
            },
            "metadata": {
                "clusterType": "function-chain",
                "relevanceScore": 1.0,
                "tokenEstimate": 250,
                "entryPoint": "src/services/pricing.ts"
            }
        }
    ],
    "totalMatches": 3,
    "searchTime": "45ms"
}
```

#### Phase 3: Performance Optimization (2-3 days)

**Caching Strategy:**

```typescript
class ClusterCache {
    private cache = new Map<string, {
        clusters: SearchCluster[];
        timestamp: number;
        fileHashes: Map<string, string>;
    }>();
    
    private readonly TTL = 5 * 60 * 1000; // 5 minutes
    
    get(query: string): SearchCluster[] | null {
        const entry = this.cache.get(query);
        if (!entry) return null;
        
        // Check TTL
        if (Date.now() - entry.timestamp > this.TTL) {
            this.cache.delete(query);
            return null;
        }
        
        return entry.clusters;
    }
    
    invalidateFile(filePath: string): void {
        for (const [query, entry] of this.cache) {
            // Invalidate if any cluster references this file
            const hasFile = entry.clusters.some(c => 
                c.seeds.some(s => s.filePath === filePath) ||
                Object.values(c.related).flat().some(r => r.filePath === filePath)
            );
            
            if (hasFile) {
                this.cache.delete(query);
            }
        }
    }
}
```

**Lazy Expansion:**

```typescript
interface LazyCluster extends Omit<SearchCluster, 'related'> {
    related: {
        callers: RelatedSymbol[] | 'lazy';
        callees: RelatedSymbol[] | 'lazy';
        typeFamily: RelatedSymbol[] | 'lazy';
        colocated: RelatedSymbol[];  // Always populated (cheap)
        siblings: RelatedSymbol[];   // Always populated (cheap)
    };
    expandRelationship(type: keyof SearchCluster['related']): Promise<RelatedSymbol[]>;
}
```

### Design Principles

1. **Token Efficiency First**: Every field should reduce agent's need for follow-up calls
2. **Leverage Existing Infrastructure**: No new parsing logic; compose existing analyzers
3. **Graceful Degradation**: If CallGraphBuilder fails, still return colocated symbols
4. **Incremental Value**: Even without full graph, clusters provide better context than flat lists

### File Structure

```
src/
├── ast/
│   ├── CallGraphBuilder.ts        # (existing)
│   ├── TypeDependencyTracker.ts   # (existing)
│   ├── SymbolIndex.ts             # (existing)
│   └── ...
├── engine/
│   ├── Search.ts                  # (existing - keyword search)
│   └── ClusterSearch.ts           # 🆕 NEW
│       ├── QueryParser
│       ├── SeedFinder
│       ├── ClusterBuilder
│       ├── ClusterRanker
│       └── ClusterCache
└── types.ts                       # Add SearchCluster types
```

## Feasibility & Risk Assessment

### Feasibility Analysis
The architecture is **highly feasible** because it orchestrates existing, proven components rather than inventing new analysis engines:
- **Symbol Matching**: `SymbolIndex` already provides robust AST-based symbol extraction.
- **Relationship Extraction**: `CallGraphBuilder` and `TypeDependencyTracker` are already implemented and tested for depth-limited analysis.
- **Module Context**: `DependencyGraph` already tracks file-level edges.

The primary challenge is **orchestration latency**, not capability. Calling multiple analyzers per search result could be slow without aggressive optimization.

### Risk Assessment

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|---------------------|
| **Latency Spikes** | High | High | **Lazy Loading**: Only fetch "cheap" context (colocated, siblings) initially. Fetch "expensive" context (call graph) only for top 1-3 matches or on demand. |
| **"God Object" Noise** | Medium | Medium | **Cluster Pruning**: Limit "related" items to top 5 by confidence. Exclude ubiquitous utilities (e.g., logging) from clustering to prevent massive, low-value clusters. |
| **False Positives** | Medium | Low | **Confidence Scoring**: Explicitly label relationships as `definite` vs `possible`. Agent can decide whether to trust "possible" links. |
| **Token Overload** | Low | High | **Strict Budgeting**: Hard limit on tokens per cluster (e.g., 2k tokens). Truncate lists (e.g., "and 15 more callers") rather than emitting all. |

## Expected Impact

### 1. Token Efficiency & Cost (High Impact)
- **Current**: Agent reads `Search.ts` (15k tokens) to find one function.
- **Proposed**: Agent receives a cluster (500 tokens) with the function signature and its 3 callers.
- **Estimate**: **90% reduction** in tokens for initial context gathering.

### 2. Context Window Management (Medium Impact)
- Reduces "pollution" of the context window with irrelevant code, allowing the agent to maintain focus on the actual task for longer periods without hitting context limits.

### 3. Agent Autonomy (High Impact)
- **Current**: Agent guesses keywords -> fails -> tries new keywords.
- **Proposed**: Agent searches once -> navigates graph.
- **Result**: "One-shot" context gathering becomes possible for moderate tasks.

## Refined Implementation Strategy

### Phase 1: MVP "Lite" Clusters (Low Complexity)
Focus on **Local Context** which is O(1) to fetch.
- **Goal**: Return matched symbols + siblings + colocated definitions.
- **No Call Graph** yet (avoids latency risks).
- **Deliverable**: `search_with_context` tool that works like `grep` but returns structured, file-scoped context.

### Phase 2: Relational Clusters (Medium Complexity)
Integrate **Call Graph & Type Hierarchy**.
- **Goal**: Add "Callers" and "Type Family" to the top 3 results only.
- **Optimization**: Use `CallGraphBuilder`'s existing depth limit (set to 1).
- **Deliverable**: Full cluster structure with cross-file links.

### Phase 3: Intelligent Ranking & Caching (High Complexity)
- **Goal**: Sub-500ms response time for full clusters.
- **Deliverable**: `ClusterCache` and advanced relevance scoring.


## Alternatives Considered

### Alternative 1: Enhance Existing Search with Rankings

Just add relevance scoring to flat results.

**Rejected**: Doesn't provide relationship context; agent still needs multiple calls.

### Alternative 2: Graph Database (Neo4j/GraphQL)

Store all relationships in a graph DB for complex queries.

**Rejected**: 
- Heavy dependency for MCP server
- Overkill for project-scoped analysis
- Violates "minimal dependencies" principle

### Alternative 3: Return Full Graphs

Return entire CallGraphResult or TypeGraphResult from search.

**Rejected**: Too verbose; clusters provide curated subsets optimized for consumption.

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Agent Tool Calls Reduction | 50% fewer calls in exploration phase | Compare call logs before/after |
| Search-to-Edit Time | < 3 calls from search to informed edit | Track tool chains in sessions |
| Token Efficiency | < 2000 tokens per cluster | Measure output size |
| Response Time | P95 < 500ms | Benchmark on medium projects |

This ADR has been refined with the following addendum based on feedback, focusing on optimizing performance, token usage, and agent experience.

## ADR-017 Addendum: Refinements for Performance, Token Control, and UX

### 1. Lazy Expansion Concretization (Expand on Demand)

**Problem Addressed**: The initial proposal for `LazyCluster` was a placeholder. `CallGraphBuilder`'s computational cost for deep expansion needs careful management to maintain responsiveness. Directly exposing all relationships could lead to high latency and token usage.

**Solution**: Implement explicit expansion control and provide clear hints to the agent for on-demand loading.

#### **Updated Type Definitions**

```typescript
// types.ts (or equivalent)

/** State of a relationship's expansion */
enum ExpansionState {
    NOT_LOADED = 'not_loaded', // Relationship data has not been fetched yet
    LOADING = 'loading',       // Currently fetching relationship data
    LOADED = 'loaded',         // Data has been fetched and is available
    FAILED = 'failed',         // Fetching failed (e.g., timeout, error)
    TRUNCATED = 'truncated',   // Data was loaded but truncated due to limits
}

/** Wrapper for related symbols to include expansion state and metadata */
interface RelatedSymbolsContainer {
    state: ExpansionState;
    data: RelatedSymbol[];     // The actual related symbols (empty if not loaded)
    error?: string;            // Error message if state is FAILED
    totalCount?: number;       // Total number of related symbols (if known and truncated)
    loadedAt?: number;         // Timestamp when data was loaded
}

interface SearchCluster {
    // ... (existing fields)
    related: {
        callers: RelatedSymbolsContainer;
        callees: RelatedSymbolsContainer;
        typeFamily: RelatedSymbolsContainer;
        colocated: RelatedSymbolsContainer; // Often fully loaded by default
        siblings: RelatedSymbolsContainer;   // Often fully loaded by default
    };
    // ... (existing fields)
}
```

#### **API Changes for `search_with_context` Tool**

The `search_with_context` tool will gain a new parameter for controlling initial expansion:

```typescript
{
    // ... (existing fields)
    inputSchema: {
        // ... (existing properties)
        properties: {
            // ... (existing query, maxClusters, expansionDepth)
            expandRelationships: { // New parameter
                type: "object",
                properties: {
                    callers: { type: "boolean", default: false, description: "Expand callers immediately" },
                    callees: { type: "boolean", default: false, description: "Expand callees immediately" },
                    typeFamily: { type: "boolean", default: false, description: "Expand type family immediately" },
                    colocated: { type: "boolean", default: true, description: "Expand co-located symbols immediately (cheap)" },
                    siblings: { type: "boolean", default: true, description: "Expand sibling symbols immediately (cheap)" },
                },
                description: "Specify which relationships to expand immediately. Others will be 'not_loaded'."
            }
        },
        // ... (existing required)
    }
}
```

#### **New Tool: `expand_cluster_relationship`**

To support on-demand expansion, a new tool will be introduced:

```typescript
{
    name: "expand_cluster_relationship",
    description: "Expands a specific relationship within a previously retrieved cluster. Use this when a cluster's relationship is 'not_loaded' or 'truncated'.",
    inputSchema: {
        type: "object",
        properties: {
            clusterId: { type: "string", description: "The unique ID of the cluster to expand." }, // (Need to add clusterId to SearchCluster)
            relationshipType: { 
                type: "string", 
                enum: ["callers", "callees", "typeFamily"], 
                description: "The type of relationship to expand." 
            },
            expansionDepth: { type: "number", default: 1, description: "Depth for this specific expansion." },
            limit: { type: "number", default: 20, description: "Maximum number of related symbols to fetch." }
        },
        required: ["clusterId", "relationshipType"]
    }
}
```

### 2. Token Control for Previews (Tiered Previews)

**Problem Addressed**: Including full code previews for all related symbols can quickly lead to token bloat, negating the benefits of clustering.

**Solution**: Implement a tiered preview system, providing more detail for seeds and concise information for related symbols.

#### **Updated Type Definitions**

```typescript
// types.ts (or equivalent)

interface ClusterSeed {
    // ... (existing fields)
    /** Full code preview (skeleton or body snippet) for the seed. ~200 tokens. */
    fullPreview?: string; 
}

interface RelatedSymbol {
    // ... (existing fields)
    /** Concise signature or declaration for related symbols. ~60 tokens. */
    signature?: string;
    /** Minimal identifier + type for very cheap display. ~25 tokens. */
    minimalPreview?: string;
}
```

#### **Preview Tiers and Token Budget**

- **Tier 1: Full Preview (`fullPreview`)**: Reserved for `seeds`. Provides `read_file_skeleton` output or a short snippet. (Estimated ~200 tokens)
- **Tier 2: Signature (`signature`)**: Used for `callers`, `callees`, `typeFamily`. Provides only the function signature, class declaration line, etc. (Estimated ~60 tokens)
- **Tier 3: Minimal (`minimalPreview`)**: Used for `colocated` and `siblings` if brevity is critical. Just symbol name and type. (Estimated ~25 tokens)

**Per-Cluster Token Budget**: Aim for approximately **1500 tokens** per cluster initially, dynamically adjusted based on overall prompt length. The `tokenEstimate` in `metadata` will reflect this tiered approach.

#### **Preview Generation Logic**

A dedicated `PreviewGenerator` class will encapsulate the logic for generating previews based on the tier and symbol type.

### 3. Enhanced Caching Strategy (Background Hot-Spot Clustering)

**Problem Addressed**: While `ClusterCache` handles query caching, frequently accessed or critical symbols might still incur latency on their first lookup or after invalidation.

**Solution**: Introduce proactive background pre-computation for "hot spot" symbols.

#### **New Component: `HotSpotDetector`**

```typescript
// engine/HotSpotDetector.ts
class HotSpotDetector {
    private symbolIndex: SymbolIndex;
    // ... (constructor, etc.)

    /** Identifies symbols that are likely to be queried often or are critical. */
    async identifyHotSpots(): Promise<Array<{ filePath: string; symbolName: string; reason: string }>> {
        const hotSpots: Array<{ filePath: string; symbolName: string; reason: string }> = [];
        // Heuristic 1: Symbols with high incoming reference count (from CallGraph/TypeGraph)
        // Heuristic 2: Symbols matching common patterns (e.g., "*Service", "*Controller", "*Hook")
        // Heuristic 3: Exported symbols from common entry point files (e.g., index.ts, main.ts)
        // ... (implementation using SymbolIndex and CallGraphBuilder for incoming refs)
        return hotSpots;
    }
}
```

#### **New Component: `ClusterPrecomputationEngine`**

```typescript
// engine/ClusterPrecomputationEngine.ts
class ClusterPrecomputationEngine {
    private hotSpotDetector: HotSpotDetector;
    private clusterSearchEngine: ClusterSearchEngine; // To build clusters
    private clusterCache: ClusterCache;             // To store precomputed results
    private runIntervalMs: number = 5 * 60 * 1000; // Every 5 minutes

    // ... (constructor)

    start() { /* ... sets up interval timer ... */ }
    stop() { /* ... clears interval timer ... */ }

    private async runPrecomputationCycle() {
        const hotSpots = await this.hotSpotDetector.identifyHotSpots();
        for (const spot of hotSpots) {
            // Check if already cached and fresh enough
            if (!this.clusterCache.isCachedAndFresh(spot.symbolName, spot.filePath)) {
                // Pre-compute with a default, limited expansion depth
                const cluster = await this.clusterSearchEngine.search(
                    spot.symbolName, 
                    { maxClusters: 1, expansionDepth: 1, ...defaultExpandRelationships }
                );
                this.clusterCache.setPrecomputed(spot.symbolName, spot.filePath, cluster);
            }
        }
        // Evict stale/least-used entries if cache size exceeds limit (LRU-style)
        this.clusterCache.evictOldEntries();
    }
}
```

#### **Updated `ClusterCache`**

The `ClusterCache` will be extended to distinguish precomputed entries and optimize eviction:

```typescript
class ClusterCache {
    // ... (existing fields and methods)

    // New: Track precomputed vs. user-queried
    setPrecomputed(query: string, filePath: string, cluster: SearchCluster[]): void { /* ... */ }
    isCachedAndFresh(query: string, filePath: string): boolean { /* ... */ }

    // New: LRU-style eviction based on hit count/last access for optimized background management
    evictOldEntries(): void { /* ... */ }
}
```

These refinements introduce a more robust and granular control over the search mechanism, directly addressing the concerns about latency, token usage, and providing a smoother experience for AI agents.

## Implementation Checklist (Updated)

### Phase 1: Core Engine (3-4 days)
- [x] Define `SearchCluster` types in `types.ts`
  - *Includes `RelatedSymbolsContainer` and `ExpansionState` enum.*
- [x] Implement `QueryParser` class
- [x] Implement `SeedFinder` class
- [x] Implement `ClusterBuilder` class
- [x] Implement `ClusterRanker` class
- [ ] Create `ClusterSearchEngine` facade class
  - *Must integrate `expandRelationships` parameter and handle `RelatedSymbolsContainer`.*
- [ ] Implement `PreviewGenerator` (tiered previews)
- [ ] Unit tests for each component

### Phase 2: MCP Integration (1-2 days)
- [ ] Add `search_with_context` tool definition
  - *Update inputSchema with `expandRelationships`.*
- [ ] Add `expand_cluster_relationship` tool definition
- [ ] Implement handlers in `handleCallTool` for both new tools
- [ ] Wire up cache invalidation in existing hooks
- [ ] Integration tests

### Phase 3: Optimization (2-3 days)
- [ ] Implement `ClusterCache` (updated with precomputation awareness)
- [ ] Implement `HotSpotDetector`
- [ ] Implement `ClusterPrecomputationEngine`
- [ ] Add lazy expansion option (as per `RelatedSymbolsContainer` and new tool)
- [ ] Performance benchmarks
- [ ] Documentation update


## Related Documents

- [ADR-016: Impact Flow Analysis](./ADR-016-impact-flow-analysis.md) - CallGraphBuilder foundation
- [ADR-010: Smart Semantic Analysis](./ADR-010-smart-semantic-analysis.md) - AST infrastructure
- [ADR-014: Smart File Profile](./ADR-014-smart-file-profile.md) - Token-efficient output patterns

---

**Author**: DevKwan  
**Date**: 2025-12-10  
**Status**: Proposed
