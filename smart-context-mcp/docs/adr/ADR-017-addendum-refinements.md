# ADR-017 Addendum: Lazy Expansion, Token Control & Caching Refinements

## Status
Proposed (Addendum to ADR-017)

## Context

ADR-017 establishes the foundation for context-aware clustered search. This addendum concretizes three critical implementation details that were outlined but not fully specified:

1. **Lazy Expansion**: The `LazyCluster` interface was introduced but lacked explicit handling mechanisms
2. **Token Control**: Preview generation strategy was under-specified for cost management
3. **Caching Strategy**: Hot spot pre-computation was mentioned but not defined

## Decision

### 1. Lazy Expansion Concretization

#### 1.1 Expansion State Machine

Replace the vague `'lazy'` marker with an explicit expansion state:

```typescript
/** Expansion state for deferred relationship loading */
type ExpansionState = 
    | 'not_loaded'      // Never fetched
    | 'loading'         // Fetch in progress
    | 'loaded'          // Data available
    | 'failed'          // Fetch failed (with reason)
    | 'truncated';      // Partial data due to limits

interface RelatedSymbolsContainer {
    state: ExpansionState;
    data: RelatedSymbol[];
    /** Error message when state is 'failed' */
    error?: string;
    /** Total count when state is 'truncated' */
    totalCount?: number;
    /** Timestamp of last load attempt */
    loadedAt?: number;
}

interface SearchCluster {
    seeds: ClusterSeed[];
    
    /** Related symbols with explicit expansion state */
    related: {
        callers: RelatedSymbolsContainer;
        callees: RelatedSymbolsContainer;
        typeFamily: RelatedSymbolsContainer;
        colocated: RelatedSymbolsContainer;    // Always 'loaded' (cheap)
        siblings: RelatedSymbolsContainer;     // Always 'loaded' (cheap)
    };
    
    metadata: SearchClusterMetadata;
}
```

#### 1.2 Expansion Flags in Tool API

Add explicit control via `expandRelationships` parameter:

```typescript
{
    name: "search_with_context",
    inputSchema: {
        type: "object",
        properties: {
            query: { type: "string" },
            maxClusters: { type: "number", default: 5 },
            expansionDepth: { type: "number", default: 2 },
            includePreview: { type: "boolean", default: true },
            
            /** NEW: Control which relationships to expand immediately */
            expandRelationships: {
                type: "object",
                properties: {
                    callers: { type: "boolean", default: false },
                    callees: { type: "boolean", default: false },
                    typeFamily: { type: "boolean", default: false },
                    all: { type: "boolean", default: false }
                },
                description: "Selectively expand expensive relationships. 'all: true' expands everything."
            },
            
            /** NEW: Separate tool for on-demand expansion */
            clusterExpansionId: {
                type: "string",
                description: "Cluster ID to expand specific relationships (use with expandRelationships)"
            }
        },
        required: ["query"]
    }
}
```

#### 1.3 ClusterBuilder Implementation with Lazy Loading

```typescript
class ClusterBuilder {
    private readonly CHEAP_RELATIONS = ['colocated', 'siblings'] as const;
    private readonly EXPENSIVE_RELATIONS = ['callers', 'callees', 'typeFamily'] as const;
    
    async buildCluster(
        seed: ClusterSeed, 
        options: {
            depth?: number;
            expandRelationships?: {
                callers?: boolean;
                callees?: boolean;
                typeFamily?: boolean;
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
        
        // Always populate cheap relations
        await this.populateCheapRelations(seed, related);
        
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
            seeds: [seed],
            related,
            metadata: this.computeMetadata(seed, related)
        };
    }
    
    private createContainer(state: ExpansionState, data: RelatedSymbol[] = []): RelatedSymbolsContainer {
        return { state, data, loadedAt: state === 'loaded' ? Date.now() : undefined };
    }
    
    private async populateCheapRelations(seed: ClusterSeed, related: SearchCluster['related']): Promise<void> {
        try {
            const fileSymbols = await this.symbolIndex.getSymbolsForFile(seed.filePath);
            
            // Colocated: same file, different symbol
            related.colocated = {
                state: 'loaded',
                data: fileSymbols
                    .filter(s => s.name !== seed.symbol.name && s.type !== 'import')
                    .slice(0, 10)
                    .map(s => this.toRelatedSymbol(seed.filePath, s, 'same-file')),
                loadedAt: Date.now()
            };
            
            // Siblings: same container (class/module)
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
        
        related.callers.state = 'loading';
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
    
    // Similar implementations for populateCallees and populateTypeFamily...
}
```

#### 1.4 On-Demand Expansion Handler

Add a dedicated handler for expanding specific relationships after initial search:

```typescript
case "expand_cluster_relationship": {
    const { clusterId, relationshipType } = args;
    
    if (!clusterId || !relationshipType) {
        return this._createErrorResponse("MissingParameter", "Provide clusterId and relationshipType");
    }
    
    const validTypes = ['callers', 'callees', 'typeFamily'];
    if (!validTypes.includes(relationshipType)) {
        return this._createErrorResponse("InvalidParameter", `relationshipType must be one of: ${validTypes.join(', ')}`);
    }
    
    // Retrieve cluster from cache
    const cachedCluster = this.clusterSearchEngine.getCachedCluster(clusterId);
    if (!cachedCluster) {
        return this._createErrorResponse("ClusterNotFound", "Cluster expired or not found. Re-run search_with_context.");
    }
    
    // Expand the requested relationship
    const expanded = await this.clusterSearchEngine.expandRelationship(cachedCluster, relationshipType);
    
    return { content: [{ type: "text", text: JSON.stringify(expanded, null, 2) }] };
}
```

---

### 2. Token Control for Previews

#### 2.1 Tiered Preview Strategy

Define three preview tiers with explicit token budgets:

```typescript
type PreviewTier = 'full' | 'signature' | 'minimal';

interface PreviewConfig {
    tier: PreviewTier;
    maxTokens: number;
    includeDoc: boolean;
}

const PREVIEW_TIERS: Record<PreviewTier, PreviewConfig> = {
    full: { tier: 'full', maxTokens: 200, includeDoc: true },
    signature: { tier: 'signature', maxTokens: 60, includeDoc: false },
    minimal: { tier: 'minimal', maxTokens: 25, includeDoc: false }
};

/** Token allocation per cluster */
const CLUSTER_TOKEN_BUDGET = {
    seeds: 400,           // Full preview for matched symbols
    callers: 300,         // Signature previews, ~5 symbols
    callees: 300,         // Signature previews, ~5 symbols
    typeFamily: 200,      // Signature previews, ~3 symbols
    colocated: 150,       // Minimal previews, ~6 symbols
    siblings: 100,        // Minimal previews, ~4 symbols
    metadata: 50          // Fixed overhead
};
// Total: ~1500 tokens per cluster (target: <2000)
```

#### 2.2 Preview Generator with Token Enforcement

```typescript
class PreviewGenerator {
    constructor(private skeletonGenerator: SkeletonGenerator) {}
    
    /** Generate preview for seed symbols (full tier) */
    async generateSeedPreview(symbol: SymbolInfo, filePath: string, content: string): Promise<string> {
        const budget = PREVIEW_TIERS.full;
        
        // Include signature + JSDoc if available
        let preview = symbol.signature || this.extractSignature(symbol, content);
        
        if (budget.includeDoc && symbol.doc) {
            const docLines = symbol.doc.split('\n').slice(0, 3).join('\n');
            preview = `${docLines}\n${preview}`;
        }
        
        return this.truncateToTokenBudget(preview, budget.maxTokens);
    }
    
    /** Generate preview for related symbols (signature tier) */
    generateRelatedPreview(symbol: RelatedSymbol): string {
        const budget = PREVIEW_TIERS.signature;
        
        // Extract just the signature line
        // e.g., "getTotal(): number" for a method
        const signature = this.compactSignature(symbol);
        
        return this.truncateToTokenBudget(signature, budget.maxTokens);
    }
    
    /** Generate preview for colocated/siblings (minimal tier) */
    generateMinimalPreview(symbol: RelatedSymbol): string {
        const budget = PREVIEW_TIERS.minimal;
        
        // Just name and type indicator
        // e.g., "PricingConfig (interface)"
        return `${symbol.symbolName} (${symbol.symbolType})`;
    }
    
    private compactSignature(symbol: RelatedSymbol): string {
        // Format: "symbolName(params): ReturnType" or "symbolName: Type"
        if (symbol.symbolType === 'function' || symbol.symbolType === 'method') {
            // Extract from preview if available, else use name
            if (symbol.preview) {
                // Remove body: "foo(x: number): void { ... }" -> "foo(x: number): void"
                return symbol.preview.replace(/\s*\{[\s\S]*\}$/, '').trim();
            }
        }
        return symbol.symbolName;
    }
    
    private truncateToTokenBudget(text: string, maxTokens: number): string {
        // Rough estimation: 1 token ≈ 4 characters for code
        const maxChars = maxTokens * 4;
        if (text.length <= maxChars) return text;
        
        return text.substring(0, maxChars - 3) + '...';
    }
    
    /** Apply tiered previews to entire cluster */
    async applyPreviewsToCluster(cluster: SearchCluster, fileContents: Map<string, string>): Promise<SearchCluster> {
        // Seeds get full previews
        for (const seed of cluster.seeds) {
            const content = fileContents.get(seed.filePath) || '';
            seed.symbol.preview = await this.generateSeedPreview(seed.symbol, seed.filePath, content);
        }
        
        // Related symbols get signature previews
        for (const caller of cluster.related.callers.data) {
            caller.preview = this.generateRelatedPreview(caller);
        }
        for (const callee of cluster.related.callees.data) {
            callee.preview = this.generateRelatedPreview(callee);
        }
        for (const type of cluster.related.typeFamily.data) {
            type.preview = this.generateRelatedPreview(type);
        }
        
        // Colocated/siblings get minimal previews
        for (const coloc of cluster.related.colocated.data) {
            coloc.preview = this.generateMinimalPreview(coloc);
        }
        for (const sibling of cluster.related.siblings.data) {
            sibling.preview = this.generateMinimalPreview(sibling);
        }
        
        return cluster;
    }
}
```

#### 2.3 Response Output with Token Metadata

Include token estimates in the response for agent awareness:

```typescript
interface ClusterSearchResponse {
    clusters: SearchCluster[];
    totalMatches: number;
    searchTime: string;
    
    /** NEW: Token usage metadata */
    tokenUsage: {
        estimated: number;      // Total estimated tokens in response
        budget: number;         // Configured budget (e.g., 5000)
        perCluster: number[];   // Breakdown per cluster
    };
    
    /** NEW: Expansion hints for agent */
    expansionHints: {
        truncatedRelationships: Array<{
            clusterId: string;
            relationship: string;
            availableCount: number;
        }>;
        recommendedExpansions: string[];  // e.g., "Expand callers for calculatePrice for full impact analysis"
    };
}
```

---

### 3. Enhanced Caching Strategy with Hot Spot Pre-computation

#### 3.1 Hot Spot Detection

Identify frequently accessed symbols based on usage patterns:

```typescript
interface HotSpotConfig {
    /** Minimum incoming references to qualify as hot */
    minIncomingRefs: number;
    /** Symbols exported from entry points */
    trackEntryExports: boolean;
    /** Symbols matching common patterns */
    patternMatchers: RegExp[];
    /** Maximum hot spots to track */
    maxHotSpots: number;
}

const DEFAULT_HOT_SPOT_CONFIG: HotSpotConfig = {
    minIncomingRefs: 5,
    trackEntryExports: true,
    patternMatchers: [
        /^(get|set|create|update|delete|handle|process)/i,  // Common CRUD/handler patterns
        /Service$/,                                          // Service classes
        /Controller$/,                                       // Controller classes
        /^use[A-Z]/                                          // React hooks
    ],
    maxHotSpots: 50
};

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
        
        // Factor 1: Incoming references
        try {
            const incoming = await this.dependencyGraph.getDependencies(filePath, 'incoming');
            if (incoming.length >= this.config.minIncomingRefs) {
                score += Math.min(incoming.length / 2, 10);  // Cap contribution
            }
        } catch { /* ignore */ }
        
        // Factor 2: Pattern matching
        if (this.config.patternMatchers.some(pattern => pattern.test(symbol.name))) {
            score += 3;
        }
        
        // Factor 3: Entry point exports
        if (this.config.trackEntryExports && this.isEntryPointExport(filePath, symbol)) {
            score += 5;
        }
        
        // Factor 4: Symbol complexity (more methods/properties = more likely to be queried)
        if (symbol.type === 'class' || symbol.type === 'interface') {
            score += 2;
        }
        
        return score;
    }
    
    private isEntryPointExport(filePath: string, symbol: SymbolInfo): boolean {
        // Check if file is an index.ts or similar entry point
        const isIndex = /(?:^|\/)index\.(ts|js)x?$/.test(filePath);
        const hasExportModifier = symbol.modifiers?.includes('export');
        return isIndex && (hasExportModifier || symbol.type === 'export');
    }
}

interface HotSpot {
    filePath: string;
    symbolName: string;
    symbolType: string;
    score: number;
    reasons: string[];
}
```

#### 3.2 Background Pre-computation Engine

```typescript
class ClusterPrecomputationEngine {
    private precomputedClusters = new Map<string, {
        cluster: SearchCluster;
        computedAt: number;
        hitCount: number;
    }>();
    
    private precomputationQueue: HotSpot[] = [];
    private isRunning = false;
    
    constructor(
        private clusterBuilder: ClusterBuilder,
        private hotSpotDetector: HotSpotDetector,
        private config: {
            precomputeIntervalMs: number;  // How often to refresh
            maxPrecomputed: number;        // Memory limit
            staleAfterMs: number;          // When to re-compute
        } = {
            precomputeIntervalMs: 5 * 60 * 1000,  // 5 minutes
            maxPrecomputed: 30,
            staleAfterMs: 10 * 60 * 1000          // 10 minutes
        }
    ) {}
    
    /** Start background pre-computation */
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
        // Detect current hot spots
        const hotSpots = await this.hotSpotDetector.detectHotSpots();
        
        // Prioritize: new hot spots > stale cached > already fresh
        const toPre compute = this.prioritizeForPrecomputation(hotSpots);
        
        // Pre-compute in batches to avoid blocking
        const BATCH_SIZE = 5;
        for (let i = 0; i < toPre compute.length && i < this.config.maxPrecomputed; i += BATCH_SIZE) {
            const batch = toPrecompute.slice(i, i + BATCH_SIZE);
            
            await Promise.all(batch.map(async (hotSpot) => {
                const cacheKey = `${hotSpot.filePath}::${hotSpot.symbolName}`;
                
                try {
                    const cluster = await this.clusterBuilder.buildCluster(
                        {
                            filePath: hotSpot.filePath,
                            symbol: { name: hotSpot.symbolName, type: hotSpot.symbolType } as any,
                            matchType: 'exact',
                            matchScore: 1.0
                        },
                        { 
                            depth: 2,
                            expandRelationships: { all: true }  // Full expansion for hot spots
                        }
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
            
            // Yield to event loop between batches
            await new Promise(resolve => setImmediate(resolve));
        }
        
        // Evict least-used entries if over limit
        this.evictIfNeeded();
    }
    
    private prioritizeForPrecomputation(hotSpots: HotSpot[]): HotSpot[] {
        const now = Date.now();
        
        return hotSpots
            .map(hs => {
                const cacheKey = `${hs.filePath}::${hs.symbolName}`;
                const cached = this.precomputedClusters.get(cacheKey);
                
                let priority = hs.score;
                
                if (!cached) {
                    priority += 10;  // Boost uncached
                } else if (now - cached.computedAt > this.config.staleAfterMs) {
                    priority += 5;   // Boost stale
                } else {
                    priority -= 5;   // Penalize fresh
                }
                
                return { hotSpot: hs, priority };
            })
            .sort((a, b) => b.priority - a.priority)
            .map(x => x.hotSpot);
    }
    
    private evictIfNeeded(): void {
        if (this.precomputedClusters.size <= this.config.maxPrecomputed) return;
        
        // Sort by hit count (ascending) then by age (oldest first)
        const entries = Array.from(this.precomputedClusters.entries())
            .sort(([, a], [, b]) => {
                if (a.hitCount !== b.hitCount) return a.hitCount - b.hitCount;
                return a.computedAt - b.computedAt;
            });
        
        // Remove excess entries
        const toRemove = entries.slice(0, entries.length - this.config.maxPrecomputed);
        for (const [key] of toRemove) {
            this.precomputedClusters.delete(key);
        }
    }
    
    /** Check cache before building cluster */
    getPrecomputedCluster(filePath: string, symbolName: string): SearchCluster | null {
        const cacheKey = `${filePath}::${symbolName}`;
        const entry = this.precomputedClusters.get(cacheKey);
        
        if (!entry) return null;
        
        // Update hit count
        entry.hitCount++;
        
        // Check staleness
        if (Date.now() - entry.computedAt > this.config.staleAfterMs) {
            // Return stale data but mark for refresh
            this.precomputationQueue.push({
                filePath,
                symbolName,
                symbolType: entry.cluster.seeds[0]?.symbol.type || 'unknown',
                score: 100,  // High priority refresh
                reasons: ['stale_cache_hit']
            });
        }
        
        return entry.cluster;
    }
    
    /** Invalidate on file change */
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

#### 3.3 Integration with ClusterSearchEngine

```typescript
class ClusterSearchEngine {
    private cache: ClusterCache;
    private precomputationEngine: ClusterPrecomputationEngine;
    
    constructor(
        private queryParser: QueryParser,
        private seedFinder: SeedFinder,
        private clusterBuilder: ClusterBuilder,
        private clusterRanker: ClusterRanker,
        private previewGenerator: PreviewGenerator,
        hotSpotDetector: HotSpotDetector
    ) {
        this.cache = new ClusterCache();
        this.precomputationEngine = new ClusterPrecomputationEngine(
            clusterBuilder,
            hotSpotDetector
        );
    }
    
    async initialize(): Promise<void> {
        // Start background pre-computation
        this.precomputationEngine.start();
    }
    
    async shutdown(): Promise<void> {
        this.precomputationEngine.stop();
    }
    
    async search(query: string, options: SearchOptions): Promise<ClusterSearchResponse> {
        const startTime = Date.now();
        
        // 1. Parse query
        const parsed = this.queryParser.parse(query);
        
        // 2. Find seed symbols
        const seeds = await this.seedFinder.findSeeds(parsed, options.maxClusters * 2);
        
        // 3. Build clusters (with precomputation cache check)
        const clusters: SearchCluster[] = [];
        
        for (const seed of seeds) {
            // Check pre-computed cache first
            const precomputed = this.precomputationEngine.getPrecomputedCluster(
                seed.filePath, 
                seed.symbol.name
            );
            
            if (precomputed) {
                // Update seed match info from current search
                precomputed.seeds[0].matchType = seed.matchType;
                precomputed.seeds[0].matchScore = seed.matchScore;
                clusters.push(precomputed);
                continue;
            }
            
            // Build fresh cluster
            const cluster = await this.clusterBuilder.buildCluster(seed, {
                depth: options.expansionDepth,
                expandRelationships: options.expandRelationships
            });
            clusters.push(cluster);
        }
        
        // 4. Rank and limit
        const ranked = this.clusterRanker.rank(clusters).slice(0, options.maxClusters);
        
        // 5. Apply previews
        const withPreviews = await this.applyPreviews(ranked, options.includePreview);
        
        // 6. Compute token usage
        const tokenUsage = this.computeTokenUsage(withPreviews);
        
        return {
            clusters: withPreviews,
            totalMatches: seeds.length,
            searchTime: `${Date.now() - startTime}ms`,
            tokenUsage,
            expansionHints: this.generateExpansionHints(withPreviews)
        };
    }
    
    invalidateFile(filePath: string): void {
        this.cache.invalidateFile(filePath);
        this.precomputationEngine.invalidateFile(filePath);
    }
}
```

---

## Implementation Checklist Update

### Phase 1 Additions
- [ ] Implement `ExpansionState` enum and `RelatedSymbolsContainer` type
- [ ] Add `expandRelationships` parameter to `search_with_context`
- [ ] Implement `expand_cluster_relationship` tool

### Phase 2 Additions
- [ ] Implement `PreviewGenerator` with tiered token budgets
- [ ] Add `tokenUsage` to response schema
- [ ] Add `expansionHints` to response schema

### Phase 3 Additions
- [ ] Implement `HotSpotDetector` class
- [ ] Implement `ClusterPrecomputationEngine`
- [ ] Integrate pre-computation with file invalidation hooks
- [ ] Add startup/shutdown lifecycle for pre-computation

---

## Trade-offs

| Decision | Benefit | Cost |
|----------|---------|------|
| Explicit `ExpansionState` | Clear contract; no ambiguous strings | Slightly larger response payload |
| Tiered previews | Predictable token usage | Seeds may lose context without full bodies |
| Background pre-computation | Sub-100ms for hot spots | Memory overhead (~2MB for 30 clusters) |
| Hit count eviction | Keeps frequently-used clusters warm | May evict newly-hot symbols |

---

**Author**: DevKwan  
**Date**: 2025-12-10  
**Status**: Proposed (Addendum)
