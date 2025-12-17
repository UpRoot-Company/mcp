# ADR 021: Enterprise-Grade Core Enhancements

**Status:** Proposed  
**Date:** 2024-12-11  
**Authors:** Architecture Team  
**Version:** 3.1.0

## Context

Smart Context MCP has grown from a prototype to a production system. As adoption increases, three architectural gaps have emerged:

1. **Testability**: Direct `fs` module usage (28+ files) couples business logic to the filesystem, making unit testing difficult and slow.
2. **Search Quality**: Simple BM25 ranking and grep-based search don't scale for large codebases (10k+ files) and miss semantic relevance signals.
3. **Diff Quality**: Myers diff produces noisy output for refactoring operations, obscuring meaningful structural changes.

This ADR proposes solutions addressing these pillars while maintaining backward compatibility at the API level.

---

## Decision

### Pillar 1: FileSystem Abstraction (`IFileSystem`)

#### Problem Statement
Current state analysis reveals direct `fs` imports in:
- `src/engine/Editor.ts` - file read/write operations
- `src/engine/Context.ts` - directory traversal
- `src/engine/FileProfiler.ts` - stat operations
- `src/engine/History.ts` - backup management
- `src/ast/SymbolIndex.ts` - file scanning
- `src/ast/DependencyGraph.ts` - monorepo detection
- `src/ast/ModuleResolver.ts` - path resolution
- ... and 20+ more files

This creates:
- Test execution time of 15-30s for integration tests
- Inability to test edge cases (permissions, race conditions)
- Platform-specific behavior differences (Windows vs Unix)

#### Interface Design

```typescript
// src/core/filesystem/IFileSystem.ts

export interface FileStats {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode?: number;
}

export interface ReadDirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface WatchEvent {
  type: 'create' | 'modify' | 'delete' | 'rename';
  path: string;
  newPath?: string; // For rename events
}

export type WatchCallback = (event: WatchEvent) => void;
export type WatchDisposer = () => void;

export interface IFileSystem {
  // --- Core Operations ---
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  readFileSync(path: string, encoding: BufferEncoding): string;
  writeFile(path: string, content: string): Promise<void>;
  writeFileSync(path: string, content: string): void;
  
  // --- Directory Operations ---
  readdir(path: string): Promise<string[]>;
  readdirWithTypes(path: string): Promise<ReadDirEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  
  // --- Metadata Operations ---
  stat(path: string): Promise<FileStats>;
  statSync(path: string): FileStats;
  lstat(path: string): Promise<FileStats>;
  exists(path: string): Promise<boolean>;
  existsSync(path: string): boolean;
  
  // --- File Management ---
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  
  // --- Path Operations (pass-through to path module for consistency) ---
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  join(...paths: string[]): string;
  dirname(path: string): string;
  basename(path: string, ext?: string): string;
  extname(path: string): string;
  isAbsolute(path: string): boolean;
  
  // --- Watch (optional, for live-reload scenarios) ---
  watch?(path: string, callback: WatchCallback): WatchDisposer;
  
  // --- Batch Operations (performance optimization) ---
  readFiles?(paths: string[], encoding: BufferEncoding): Promise<Map<string, string | Error>>;
  statMany?(paths: string[]): Promise<Map<string, FileStats | Error>>;
}
```

#### Implementations

```typescript
// src/core/filesystem/NodeFileSystem.ts
import * as fs from 'fs';
import * as path from 'path';
import { IFileSystem, FileStats, ReadDirEntry, WatchCallback, WatchDisposer } from './IFileSystem.js';

export class NodeFileSystem implements IFileSystem {
  async readFile(filePath: string, encoding: BufferEncoding): Promise<string> {
    return fs.promises.readFile(filePath, { encoding });
  }
  
  readFileSync(filePath: string, encoding: BufferEncoding): string {
    return fs.readFileSync(filePath, { encoding });
  }
  
  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }
  
  // ... remaining implementations follow node:fs semantics
  
  // Batch optimization using Promise.allSettled
  async readFiles(paths: string[], encoding: BufferEncoding): Promise<Map<string, string | Error>> {
    const results = await Promise.allSettled(
      paths.map(p => this.readFile(p, encoding))
    );
    const map = new Map<string, string | Error>();
    paths.forEach((p, i) => {
      const result = results[i];
      map.set(p, result.status === 'fulfilled' ? result.value : result.reason);
    });
    return map;
  }
}
```

```typescript
// src/core/filesystem/MemoryFileSystem.ts
import { IFileSystem, FileStats, ReadDirEntry } from './IFileSystem.js';
import * as path from 'path';

interface MemoryNode {
  type: 'file' | 'directory';
  content?: string;
  mtime: number;
  children?: Map<string, MemoryNode>;
}

export class MemoryFileSystem implements IFileSystem {
  private root: MemoryNode = { type: 'directory', mtime: Date.now(), children: new Map() };
  private cwd: string = '/';
  
  /**
   * Seed the filesystem with files for testing.
   * @param files Record of path -> content
   */
  seed(files: Record<string, string>): void {
    for (const [filePath, content] of Object.entries(files)) {
      this.writeFileSync(filePath, content);
    }
  }
  
  /**
   * Simulate filesystem operations like permission errors.
   */
  simulateError(path: string, operation: 'read' | 'write' | 'stat', error: Error): void {
    // Implementation stores error triggers in internal map
  }
  
  // ... implementations use in-memory tree structure
}
```

```typescript
// src/core/filesystem/CachedFileSystem.ts
import { IFileSystem, FileStats } from './IFileSystem.js';
import { LRUCache } from 'lru-cache';

/**
 * Wraps another IFileSystem with an LRU cache for read operations.
 * Useful for reducing I/O in hot paths like SymbolIndex.
 */
export class CachedFileSystem implements IFileSystem {
  private contentCache: LRUCache<string, string>;
  private statCache: LRUCache<string, FileStats>;
  
  constructor(
    private delegate: IFileSystem,
    options: { maxContentEntries?: number; maxStatEntries?: number; ttl?: number } = {}
  ) {
    this.contentCache = new LRUCache({
      max: options.maxContentEntries ?? 1000,
      ttl: options.ttl ?? 60_000
    });
    this.statCache = new LRUCache({
      max: options.maxStatEntries ?? 5000,
      ttl: options.ttl ?? 30_000
    });
  }
  
  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    const cacheKey = `${path}:${encoding}`;
    const cached = this.contentCache.get(cacheKey);
    if (cached !== undefined) return cached;
    
    const content = await this.delegate.readFile(path, encoding);
    this.contentCache.set(cacheKey, content);
    return content;
  }
  
  invalidate(path: string): void {
    this.contentCache.delete(`${path}:utf-8`);
    this.statCache.delete(path);
  }
  
  // ... delegate remaining operations with optional caching
}
```

#### Dependency Injection Strategy

```typescript
// src/core/ServiceContainer.ts

export interface ServiceContainer {
  fileSystem: IFileSystem;
  // Future: logger, metrics, etc.
}

// Global default container (production)
let defaultContainer: ServiceContainer = {
  fileSystem: new NodeFileSystem()
};

export function getContainer(): ServiceContainer {
  return defaultContainer;
}

export function setContainer(container: ServiceContainer): void {
  defaultContainer = container;
}

// For testing
export function createTestContainer(overrides?: Partial<ServiceContainer>): ServiceContainer {
  return {
    fileSystem: new MemoryFileSystem(),
    ...overrides
  };
}
```

#### Migration Path

**Phase 1: Create abstractions** (Week 1)
- Create `IFileSystem` interface and implementations
- Create `ServiceContainer` with global accessor

**Phase 2: Migrate core modules** (Week 2-3)
- `Editor.ts`, `Context.ts`, `History.ts` - highest test value
- Pattern: Constructor injection with fallback to global container

```typescript
// Before
export class EditorEngine {
  constructor(rootPath: string) { /* ... */ }
}

// After
export class EditorEngine {
  private fs: IFileSystem;
  
  constructor(rootPath: string, fs?: IFileSystem) {
    this.fs = fs ?? getContainer().fileSystem;
    // ... rest unchanged
  }
}
```

**Phase 3: Migrate remaining modules** (Week 3-4)
- AST modules: `SymbolIndex.ts`, `DependencyGraph.ts`, `ModuleResolver.ts`
- Test infrastructure updates

**Phase 4: Optimize** (Week 5)
- Introduce `CachedFileSystem` for hot paths
- Add batch operations where beneficial

#### Trade-offs

| Aspect | Benefit | Cost |
|--------|---------|------|
| Testability | 10x faster unit tests, edge case coverage | +500 LoC abstraction layer |
| Flexibility | In-memory FS, caching layer | Minor indirection overhead |
| Compatibility | No external API changes | Internal refactoring effort |
| Performance | Caching can improve perf | Uncached path has ~5% overhead |

---

### Pillar 2: Google-Style Advanced Search

#### Problem Statement

Current implementation (`Search.ts`, `Ranking.ts`):
- Uses shell `grep` for pattern matching - spawns processes, slow for large codebases
- Simple BM25 without field weighting - doesn't leverage AST structure
- No index - every search scans entire codebase
- `ClusterRanker.ts` has basic scoring without semantic signals

#### Design: Trigram Index + BM25F with AST Weights

##### Trigram Indexing

Trigrams enable O(1) candidate set retrieval followed by verification:

```typescript
// src/search/TrigramIndex.ts

export interface TrigramIndex {
  /**
   * Maps each trigram to the set of documents containing it.
   * Trigram: 3-character substring, lowercase normalized
   * Value: Set of document IDs (file paths)
   */
  trigramToDocuments: Map<string, Set<string>>;
  
  /**
   * Document metadata for ranking
   */
  documents: Map<string, DocumentMeta>;
  
  /**
   * Build statistics
   */
  stats: {
    totalDocuments: number;
    totalTrigrams: number;
    avgTrigramsPerDoc: number;
    buildTimeMs: number;
    lastUpdated: string;
  };
}

export interface DocumentMeta {
  path: string;
  size: number;
  lineCount: number;
  language: string | null;
  trigramCount: number;
  /**
   * Pre-computed term frequencies for BM25
   * Key: normalized token, Value: count
   */
  termFrequencies: Map<string, number>;
}

export class TrigramIndexBuilder {
  private fs: IFileSystem;
  private supportedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp']);
  
  constructor(fs: IFileSystem) {
    this.fs = fs;
  }
  
  /**
   * Build index for a directory
   * @param rootPath Project root
   * @param options Configuration
   */
  async build(rootPath: string, options?: {
    excludePatterns?: string[];
    maxFileSize?: number;
    incremental?: TrigramIndex;
  }): Promise<TrigramIndex> {
    const startTime = Date.now();
    const index: TrigramIndex = options?.incremental ?? {
      trigramToDocuments: new Map(),
      documents: new Map(),
      stats: { totalDocuments: 0, totalTrigrams: 0, avgTrigramsPerDoc: 0, buildTimeMs: 0, lastUpdated: '' }
    };
    
    const files = await this.scanFiles(rootPath, options?.excludePatterns ?? []);
    
    for (const file of files) {
      await this.indexFile(file, rootPath, index, options?.maxFileSize ?? 1_000_000);
    }
    
    // Update stats
    const trigramCounts = Array.from(index.documents.values()).map(d => d.trigramCount);
    index.stats = {
      totalDocuments: index.documents.size,
      totalTrigrams: index.trigramToDocuments.size,
      avgTrigramsPerDoc: trigramCounts.length > 0 
        ? trigramCounts.reduce((a, b) => a + b, 0) / trigramCounts.length 
        : 0,
      buildTimeMs: Date.now() - startTime,
      lastUpdated: new Date().toISOString()
    };
    
    return index;
  }
  
  /**
   * Extract trigrams from text
   */
  extractTrigrams(text: string): Set<string> {
    const normalized = text.toLowerCase();
    const trigrams = new Set<string>();
    
    for (let i = 0; i <= normalized.length - 3; i++) {
      const trigram = normalized.substring(i, i + 3);
      // Skip trigrams that are all whitespace
      if (!/^\s+$/.test(trigram)) {
        trigrams.add(trigram);
      }
    }
    
    return trigrams;
  }
  
  private async indexFile(
    filePath: string, 
    rootPath: string, 
    index: TrigramIndex,
    maxSize: number
  ): Promise<void> {
    const stat = await this.fs.stat(filePath);
    if (stat.size > maxSize) return;
    
    const content = await this.fs.readFile(filePath, 'utf-8');
    const relativePath = this.fs.relative(rootPath, filePath);
    const trigrams = this.extractTrigrams(content);
    
    // Add to inverted index
    for (const trigram of trigrams) {
      if (!index.trigramToDocuments.has(trigram)) {
        index.trigramToDocuments.set(trigram, new Set());
      }
      index.trigramToDocuments.get(trigram)!.add(relativePath);
    }
    
    // Store document metadata
    const tokens = this.tokenize(content);
    const termFrequencies = new Map<string, number>();
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }
    
    index.documents.set(relativePath, {
      path: relativePath,
      size: stat.size,
      lineCount: content.split('\n').length,
      language: this.detectLanguage(filePath),
      trigramCount: trigrams.size,
      termFrequencies
    });
  }
  
  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1);
  }
  
  private detectLanguage(filePath: string): string | null {
    const ext = this.fs.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript',
      '.js': 'javascript', '.jsx': 'javascript',
      '.py': 'python', '.go': 'go', '.rs': 'rust',
      '.java': 'java', '.c': 'c', '.cpp': 'cpp'
    };
    return langMap[ext] ?? null;
  }
  
  private async scanFiles(rootPath: string, excludePatterns: string[]): Promise<string[]> {
    // Implementation using IFileSystem.readdirWithTypes recursively
    // Respects excludePatterns (glob matching)
    return [];
  }
}
```

##### BM25F with AST Field Weights

BM25F (BM25 with Field weights) scores documents based on multiple fields with different boosts:

```typescript
// src/search/BM25FRanker.ts

export interface FieldWeights {
  /** Class/interface/function names - highest signal */
  symbolName: number;
  /** JSDoc/docstrings */
  documentation: number;
  /** Function signatures, parameters, return types */
  signature: number;
  /** General code content */
  body: number;
  /** Import/export statements */
  imports: number;
  /** File path components */
  path: number;
}

export const DEFAULT_FIELD_WEIGHTS: FieldWeights = {
  symbolName: 10.0,
  documentation: 4.0,
  signature: 6.0,
  body: 1.0,
  imports: 2.0,
  path: 3.0
};

export interface ScoredDocument {
  path: string;
  score: number;
  breakdown: {
    fieldScores: Record<keyof FieldWeights, number>;
    matchedTerms: string[];
    lineHits: number[];
  };
}

export interface DocumentFields {
  symbolName: string[];      // ['MyClass', 'handleSubmit', 'fetchData']
  documentation: string[];   // ['/** Handles form submission */']
  signature: string[];       // ['handleSubmit(event: Event): void']
  body: string;              // Full file content
  imports: string[];         // ['import { useState } from "react"']
  path: string;              // 'src/components/Form.tsx'
}

export class BM25FRanker {
  private k1: number;
  private b: number;
  private weights: FieldWeights;
  
  // Pre-computed IDF values
  private idfCache = new Map<string, number>();
  
  // Average document lengths per field
  private avgFieldLengths: Record<keyof FieldWeights, number> = {
    symbolName: 0, documentation: 0, signature: 0,
    body: 0, imports: 0, path: 0
  };
  
  constructor(
    k1: number = 1.2,
    b: number = 0.75,
    weights: FieldWeights = DEFAULT_FIELD_WEIGHTS
  ) {
    this.k1 = k1;
    this.b = b;
    this.weights = weights;
  }
  
  /**
   * Pre-compute statistics from corpus
   */
  initializeFromCorpus(documents: DocumentFields[]): void {
    const fieldLengths: Record<keyof FieldWeights, number[]> = {
      symbolName: [], documentation: [], signature: [],
      body: [], imports: [], path: []
    };
    
    const termDocCounts = new Map<string, number>();
    
    for (const doc of documents) {
      // Collect field lengths
      fieldLengths.symbolName.push(this.tokenize(doc.symbolName.join(' ')).length);
      fieldLengths.documentation.push(this.tokenize(doc.documentation.join(' ')).length);
      fieldLengths.signature.push(this.tokenize(doc.signature.join(' ')).length);
      fieldLengths.body.push(this.tokenize(doc.body).length);
      fieldLengths.imports.push(this.tokenize(doc.imports.join(' ')).length);
      fieldLengths.path.push(this.tokenize(doc.path).length);
      
      // Collect document frequencies for IDF
      const docTerms = new Set([
        ...this.tokenize(doc.symbolName.join(' ')),
        ...this.tokenize(doc.documentation.join(' ')),
        ...this.tokenize(doc.signature.join(' ')),
        ...this.tokenize(doc.body),
        ...this.tokenize(doc.imports.join(' ')),
        ...this.tokenize(doc.path)
      ]);
      
      for (const term of docTerms) {
        termDocCounts.set(term, (termDocCounts.get(term) ?? 0) + 1);
      }
    }
    
    // Compute averages
    for (const field of Object.keys(fieldLengths) as Array<keyof FieldWeights>) {
      const lengths = fieldLengths[field];
      this.avgFieldLengths[field] = lengths.length > 0
        ? lengths.reduce((a, b) => a + b, 0) / lengths.length
        : 1;
    }
    
    // Compute IDF values
    const N = documents.length;
    for (const [term, docFreq] of termDocCounts) {
      const idf = Math.log(((N - docFreq + 0.5) / (docFreq + 0.5)) + 1);
      this.idfCache.set(term, idf);
    }
  }
  
  /**
   * Score a single document against a query
   */
  score(doc: DocumentFields, queryTerms: string[]): ScoredDocument {
    const breakdown: ScoredDocument['breakdown'] = {
      fieldScores: { symbolName: 0, documentation: 0, signature: 0, body: 0, imports: 0, path: 0 },
      matchedTerms: [],
      lineHits: []
    };
    
    let totalScore = 0;
    const matchedTermsSet = new Set<string>();
    
    for (const field of Object.keys(this.weights) as Array<keyof FieldWeights>) {
      const fieldText = this.getFieldText(doc, field);
      const fieldTokens = this.tokenize(fieldText);
      const fieldLength = fieldTokens.length;
      const avgLength = this.avgFieldLengths[field] || 1;
      const weight = this.weights[field];
      
      let fieldScore = 0;
      
      for (const term of queryTerms) {
        const tf = fieldTokens.filter(t => t === term).length;
        if (tf > 0) {
          matchedTermsSet.add(term);
          const idf = this.idfCache.get(term) ?? Math.log(1.5);
          
          // BM25 formula
          const numerator = tf * (this.k1 + 1);
          const denominator = tf + this.k1 * (1 - this.b + this.b * (fieldLength / avgLength));
          const termScore = idf * (numerator / denominator);
          
          fieldScore += termScore;
        }
      }
      
      // Apply field weight
      breakdown.fieldScores[field] = fieldScore * weight;
      totalScore += fieldScore * weight;
    }
    
    breakdown.matchedTerms = Array.from(matchedTermsSet);
    
    // Find line hits for preview
    const lines = doc.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineTokens = this.tokenize(lines[i]);
      if (queryTerms.some(term => lineTokens.includes(term))) {
        breakdown.lineHits.push(i + 1);
      }
    }
    
    return { path: doc.path, score: totalScore, breakdown };
  }
  
  /**
   * Rank multiple documents
   */
  rank(documents: DocumentFields[], query: string): ScoredDocument[] {
    const queryTerms = this.tokenize(query);
    
    return documents
      .map(doc => this.score(doc, queryTerms))
      .filter(scored => scored.score > 0)
      .sort((a, b) => b.score - a.score);
  }
  
  private getFieldText(doc: DocumentFields, field: keyof FieldWeights): string {
    switch (field) {
      case 'symbolName': return doc.symbolName.join(' ');
      case 'documentation': return doc.documentation.join(' ');
      case 'signature': return doc.signature.join(' ');
      case 'body': return doc.body;
      case 'imports': return doc.imports.join(' ');
      case 'path': return doc.path;
    }
  }
  
  private tokenize(text: string): string[] {
    // Improved tokenizer: handles camelCase, snake_case, kebab-case
    return text
      .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase -> camel Case
      .replace(/[_-]/g, ' ')                 // snake_case -> snake case
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 1);
  }
}
```

##### Integration: Enhanced SearchEngine

```typescript
// src/search/EnhancedSearchEngine.ts

import { TrigramIndex, TrigramIndexBuilder } from './TrigramIndex.js';
import { BM25FRanker, DocumentFields, ScoredDocument } from './BM25FRanker.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { IFileSystem } from '../core/filesystem/IFileSystem.js';

export interface SearchResult {
  path: string;
  score: number;
  preview: string;
  lineHits: number[];
  symbolMatches?: string[];
}

export interface SearchOptions {
  maxResults?: number;
  includeSymbolSearch?: boolean;
  minScore?: number;
  filePattern?: string;
}

export class EnhancedSearchEngine {
  private trigramIndex: TrigramIndex | null = null;
  private documentFields = new Map<string, DocumentFields>();
  private ranker: BM25FRanker;
  private indexBuilder: TrigramIndexBuilder;
  
  constructor(
    private fs: IFileSystem,
    private skeletonGenerator: SkeletonGenerator,
    private rootPath: string
  ) {
    this.ranker = new BM25FRanker();
    this.indexBuilder = new TrigramIndexBuilder(fs);
  }
  
  /**
   * Build or rebuild the search index
   */
  async buildIndex(options?: { force?: boolean }): Promise<void> {
    if (this.trigramIndex && !options?.force) return;
    
    this.trigramIndex = await this.indexBuilder.build(this.rootPath, {
      excludePatterns: ['node_modules/**', '.git/**', 'dist/**', 'coverage/**']
    });
    
    // Extract document fields for BM25F
    await this.extractDocumentFields();
    
    // Initialize ranker with corpus statistics
    const docs = Array.from(this.documentFields.values());
    this.ranker.initializeFromCorpus(docs);
  }
  
  /**
   * Search the codebase
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.trigramIndex) {
      await this.buildIndex();
    }
    
    const { maxResults = 50, minScore = 0.1, includeSymbolSearch = true } = options;
    
    // Step 1: Trigram filtering for candidate documents
    const candidates = this.findCandidates(query);
    
    if (candidates.size === 0) {
      return [];
    }
    
    // Step 2: BM25F ranking on candidates
    const candidateDocs = Array.from(candidates)
      .map(path => this.documentFields.get(path))
      .filter((doc): doc is DocumentFields => doc !== undefined);
    
    const scored = this.ranker.rank(candidateDocs, query);
    
    // Step 3: Apply filters and build results
    return scored
      .filter(s => s.score >= minScore)
      .slice(0, maxResults)
      .map(s => this.buildResult(s));
  }
  
  /**
   * Find candidate documents using trigram index
   */
  private findCandidates(query: string): Set<string> {
    const queryTrigrams = this.indexBuilder.extractTrigrams(query);
    
    if (queryTrigrams.size === 0) {
      // Fallback to all documents for very short queries
      return new Set(this.trigramIndex!.documents.keys());
    }
    
    // Intersection of document sets for each trigram
    let candidates: Set<string> | null = null;
    
    for (const trigram of queryTrigrams) {
      const docs = this.trigramIndex!.trigramToDocuments.get(trigram);
      
      if (!docs || docs.size === 0) {
        // Trigram not found - use OR semantics (union) instead of AND (intersection)
        continue;
      }
      
      if (candidates === null) {
        candidates = new Set(docs);
      } else {
        // For short queries, use union (OR); for longer queries, use intersection (AND)
        if (queryTrigrams.size <= 5) {
          for (const doc of docs) candidates.add(doc);
        } else {
          candidates = new Set([...candidates].filter(d => docs.has(d)));
        }
      }
    }
    
    return candidates ?? new Set();
  }
  
  private async extractDocumentFields(): Promise<void> {
    this.documentFields.clear();
    
    for (const [path, meta] of this.trigramIndex!.documents) {
      try {
        const fullPath = this.fs.join(this.rootPath, path);
        const content = await this.fs.readFile(fullPath, 'utf-8');
        const structure = await this.skeletonGenerator.generateStructureJson(fullPath, content);
        
        const fields: DocumentFields = {
          symbolName: [],
          documentation: [],
          signature: [],
          body: content,
          imports: [],
          path
        };
        
        for (const symbol of structure) {
          fields.symbolName.push(symbol.name);
          
          if (symbol.doc) {
            fields.documentation.push(symbol.doc);
          }
          
          if ('signature' in symbol && symbol.signature) {
            fields.signature.push(symbol.signature);
          }
          
          if (symbol.type === 'import') {
            fields.imports.push(symbol.content ?? symbol.name);
          }
        }
        
        this.documentFields.set(path, fields);
      } catch (error) {
        // Skip files that can't be parsed
      }
    }
  }
  
  private buildResult(scored: ScoredDocument): SearchResult {
    const doc = this.documentFields.get(scored.path);
    
    // Generate preview from first line hit
    let preview = '';
    if (doc && scored.breakdown.lineHits.length > 0) {
      const lines = doc.body.split('\n');
      const lineNum = scored.breakdown.lineHits[0];
      preview = lines[lineNum - 1]?.trim().substring(0, 100) ?? '';
    }
    
    return {
      path: scored.path,
      score: scored.score,
      preview,
      lineHits: scored.breakdown.lineHits.slice(0, 10),
      symbolMatches: scored.breakdown.matchedTerms.length > 0
        ? scored.breakdown.matchedTerms
        : undefined
    };
  }
  
  /**
   * Invalidate index for a specific file (for incremental updates)
   */
  invalidateFile(filePath: string): void {
    const relativePath = this.fs.relative(this.rootPath, filePath);
    this.documentFields.delete(relativePath);
    
    // Remove from trigram index
    if (this.trigramIndex) {
      this.trigramIndex.documents.delete(relativePath);
      for (const docs of this.trigramIndex.trigramToDocuments.values()) {
        docs.delete(relativePath);
      }
    }
  }
}
```

#### Complexity Analysis

| Operation | Current (grep) | Proposed (Trigram + BM25F) |
|-----------|----------------|----------------------------|
| Search (10k files) | O(n × m) ~15s | O(k × log k) ~50ms |
| Index build | N/A | O(n × avg_size) ~30s one-time |
| Memory | ~0 | ~50-100MB for 10k files |
| Incremental update | N/A | O(file_size) |

Where:
- n = number of files
- m = average file size
- k = candidate set size (typically 1-5% of n)

#### Trade-offs

| Aspect | Benefit | Cost |
|--------|---------|------|
| Speed | 100-300x faster search | 30s initial index build |
| Quality | Semantic ranking with AST awareness | More complex code |
| Memory | Instant repeated searches | 50-100MB index |
| Maintenance | Incremental updates | Index invalidation logic |

---

### Pillar 3: Semantic Diffing (Patience Diff)

#### Problem Statement

Current Myers diff (`Diff.ts`) produces noisy output for common refactoring operations:
- Moving functions shows as delete + add instead of move
- Renaming creates scattered changes
- Adding/removing blank lines pollutes the diff

#### Patience Diff Algorithm

Patience diff uses Longest Increasing Subsequence (LIS) on unique lines to anchor the diff:

```typescript
// src/engine/PatienceDiff.ts

interface DiffHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  type: 'equal' | 'insert' | 'delete' | 'replace';
  oldLines: string[];
  newLines: string[];
}

interface DiffOptions {
  /** Ignore changes in whitespace */
  ignoreWhitespace?: boolean;
  /** Context lines around changes */
  contextLines?: number;
  /** Semantic mode groups related changes */
  semantic?: boolean;
}

export class PatienceDiff {
  /**
   * Main entry point - compute diff between two texts
   */
  static diff(oldText: string, newText: string, options: DiffOptions = {}): DiffHunk[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    
    const normalizedOld = options.ignoreWhitespace 
      ? oldLines.map(l => l.trim()) 
      : oldLines;
    const normalizedNew = options.ignoreWhitespace 
      ? newLines.map(l => l.trim()) 
      : newLines;
    
    // Step 1: Find unique lines that appear exactly once in both
    const uniqueMatches = this.findUniqueMatches(normalizedOld, normalizedNew);
    
    // Step 2: Find LIS of unique matches
    const lis = this.longestIncreasingSubsequence(uniqueMatches);
    
    // Step 3: Build hunks using LIS as anchors
    const hunks = this.buildHunks(oldLines, newLines, lis, options);
    
    // Step 4: Optionally apply semantic grouping
    if (options.semantic) {
      return this.semanticGroup(hunks);
    }
    
    return hunks;
  }
  
  /**
   * Find lines that are unique in both sequences and match
   */
  private static findUniqueMatches(
    oldLines: string[], 
    newLines: string[]
  ): Array<{ oldIndex: number; newIndex: number }> {
    // Count occurrences in each sequence
    const oldCounts = new Map<string, { count: number; index: number }>();
    const newCounts = new Map<string, { count: number; index: number }>();
    
    oldLines.forEach((line, i) => {
      const existing = oldCounts.get(line);
      if (existing) {
        existing.count++;
      } else {
        oldCounts.set(line, { count: 1, index: i });
      }
    });
    
    newLines.forEach((line, i) => {
      const existing = newCounts.get(line);
      if (existing) {
        existing.count++;
      } else {
        newCounts.set(line, { count: 1, index: i });
      }
    });
    
    // Find lines unique to both with matching content
    const matches: Array<{ oldIndex: number; newIndex: number }> = [];
    
    for (const [line, oldInfo] of oldCounts) {
      if (oldInfo.count !== 1) continue;
      
      const newInfo = newCounts.get(line);
      if (!newInfo || newInfo.count !== 1) continue;
      
      matches.push({ oldIndex: oldInfo.index, newIndex: newInfo.index });
    }
    
    // Sort by old index
    return matches.sort((a, b) => a.oldIndex - b.oldIndex);
  }
  
  /**
   * Compute Longest Increasing Subsequence on newIndex values
   */
  private static longestIncreasingSubsequence(
    matches: Array<{ oldIndex: number; newIndex: number }>
  ): Array<{ oldIndex: number; newIndex: number }> {
    if (matches.length === 0) return [];
    
    const n = matches.length;
    const dp: number[] = new Array(n).fill(1);
    const parent: number[] = new Array(n).fill(-1);
    
    // Standard LIS DP
    for (let i = 1; i < n; i++) {
      for (let j = 0; j < i; j++) {
        if (matches[j].newIndex < matches[i].newIndex && dp[j] + 1 > dp[i]) {
          dp[i] = dp[j] + 1;
          parent[i] = j;
        }
      }
    }
    
    // Find the end of the longest sequence
    let maxLen = 0;
    let maxIdx = 0;
    for (let i = 0; i < n; i++) {
      if (dp[i] > maxLen) {
        maxLen = dp[i];
        maxIdx = i;
      }
    }
    
    // Reconstruct the sequence
    const lis: Array<{ oldIndex: number; newIndex: number }> = [];
    let idx: number | null = maxIdx;
    while (idx !== null && idx !== -1) {
      lis.unshift(matches[idx]);
      idx = parent[idx];
    }
    
    return lis;
  }
  
  /**
   * Build diff hunks using anchors from LIS
   */
  private static buildHunks(
    oldLines: string[],
    newLines: string[],
    anchors: Array<{ oldIndex: number; newIndex: number }>,
    options: DiffOptions
  ): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    let oldPos = 0;
    let newPos = 0;
    
    for (const anchor of anchors) {
      // Process gap before this anchor
      if (oldPos < anchor.oldIndex || newPos < anchor.newIndex) {
        const gapHunks = this.processGap(
          oldLines, newLines,
          oldPos, anchor.oldIndex,
          newPos, anchor.newIndex
        );
        hunks.push(...gapHunks);
      }
      
      // Add anchor as equal
      hunks.push({
        oldStart: anchor.oldIndex,
        oldEnd: anchor.oldIndex + 1,
        newStart: anchor.newIndex,
        newEnd: anchor.newIndex + 1,
        type: 'equal',
        oldLines: [oldLines[anchor.oldIndex]],
        newLines: [newLines[anchor.newIndex]]
      });
      
      oldPos = anchor.oldIndex + 1;
      newPos = anchor.newIndex + 1;
    }
    
    // Process remaining gap
    if (oldPos < oldLines.length || newPos < newLines.length) {
      const finalHunks = this.processGap(
        oldLines, newLines,
        oldPos, oldLines.length,
        newPos, newLines.length
      );
      hunks.push(...finalHunks);
    }
    
    return this.mergeAdjacentHunks(hunks, options.contextLines ?? 3);
  }
  
  /**
   * Process a gap between anchors recursively
   */
  private static processGap(
    oldLines: string[],
    newLines: string[],
    oldStart: number,
    oldEnd: number,
    newStart: number,
    newEnd: number
  ): DiffHunk[] {
    const oldSlice = oldLines.slice(oldStart, oldEnd);
    const newSlice = newLines.slice(newStart, newEnd);
    
    if (oldSlice.length === 0 && newSlice.length === 0) {
      return [];
    }
    
    if (oldSlice.length === 0) {
      return [{
        oldStart, oldEnd,
        newStart, newEnd,
        type: 'insert',
        oldLines: [],
        newLines: newSlice
      }];
    }
    
    if (newSlice.length === 0) {
      return [{
        oldStart, oldEnd,
        newStart, newEnd,
        type: 'delete',
        oldLines: oldSlice,
        newLines: []
      }];
    }
    
    // Recursively apply patience diff to the gap
    // For small gaps, use simple comparison
    if (oldSlice.length <= 3 && newSlice.length <= 3) {
      return [{
        oldStart, oldEnd,
        newStart, newEnd,
        type: 'replace',
        oldLines: oldSlice,
        newLines: newSlice
      }];
    }
    
    // Recursive patience diff
    const subMatches = this.findUniqueMatches(oldSlice, newSlice);
    if (subMatches.length === 0) {
      return [{
        oldStart, oldEnd,
        newStart, newEnd,
        type: 'replace',
        oldLines: oldSlice,
        newLines: newSlice
      }];
    }
    
    // Adjust indices back to original positions
    const adjustedMatches = subMatches.map(m => ({
      oldIndex: m.oldIndex + oldStart,
      newIndex: m.newIndex + newStart
    }));
    
    const subLis = this.longestIncreasingSubsequence(adjustedMatches);
    return this.buildHunks(oldLines, newLines, subLis, {});
  }
  
  /**
   * Merge adjacent hunks and add context
   */
  private static mergeAdjacentHunks(hunks: DiffHunk[], contextLines: number): DiffHunk[] {
    // Implementation merges hunks that are within contextLines of each other
    return hunks;
  }
  
  /**
   * Group related changes semantically (e.g., function moves)
   */
  private static semanticGroup(hunks: DiffHunk[]): DiffHunk[] {
    // Detect move patterns: delete of block A followed by insert of similar block
    // Group renames: delete of identifier followed by insert of similar identifier
    return hunks;
  }
  
  /**
   * Format hunks as unified diff string
   */
  static formatUnified(hunks: DiffHunk[], options?: { colorize?: boolean }): string {
    const lines: string[] = [];
    
    for (const hunk of hunks) {
      // Hunk header
      lines.push(`@@ -${hunk.oldStart + 1},${hunk.oldEnd - hunk.oldStart} +${hunk.newStart + 1},${hunk.newEnd - hunk.newStart} @@`);
      
      switch (hunk.type) {
        case 'equal':
          for (const line of hunk.oldLines) {
            lines.push(` ${line}`);
          }
          break;
        case 'delete':
          for (const line of hunk.oldLines) {
            lines.push(`-${line}`);
          }
          break;
        case 'insert':
          for (const line of hunk.newLines) {
            lines.push(`+${line}`);
          }
          break;
        case 'replace':
          for (const line of hunk.oldLines) {
            lines.push(`-${line}`);
          }
          for (const line of hunk.newLines) {
            lines.push(`+${line}`);
          }
          break;
      }
    }
    
    return lines.join('\n');
  }
  
  /**
   * Compute summary statistics
   */
  static summarize(hunks: DiffHunk[]): { added: number; removed: number; changed: number } {
    let added = 0, removed = 0, changed = 0;
    
    for (const hunk of hunks) {
      switch (hunk.type) {
        case 'insert':
          added += hunk.newLines.length;
          break;
        case 'delete':
          removed += hunk.oldLines.length;
          break;
        case 'replace':
          changed += Math.max(hunk.oldLines.length, hunk.newLines.length);
          break;
      }
    }
    
    return { added, removed, changed };
  }
}
```

##### AST-Aware Diff Extensions

```typescript
// src/engine/AstAwareDiff.ts

import { PatienceDiff, DiffHunk } from './PatienceDiff.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { SymbolInfo } from '../types.js';

export interface SemanticChange {
  type: 'add' | 'remove' | 'modify' | 'move' | 'rename';
  symbolType: 'function' | 'class' | 'interface' | 'variable' | 'import' | 'unknown';
  name: string;
  oldName?: string;  // For renames
  oldLocation?: { start: number; end: number };
  newLocation?: { start: number; end: number };
  hunks: DiffHunk[];
}

export class AstAwareDiff {
  constructor(private skeletonGenerator: SkeletonGenerator) {}
  
  /**
   * Compute semantic diff between two versions of a file
   */
  async diff(
    filePath: string,
    oldContent: string,
    newContent: string
  ): Promise<{
    hunks: DiffHunk[];
    semanticChanges: SemanticChange[];
    summary: { added: number; removed: number; changed: number };
  }> {
    // Get patience diff
    const hunks = PatienceDiff.diff(oldContent, newContent, {
      semantic: true,
      contextLines: 3
    });
    
    // Extract symbols from both versions
    const [oldSymbols, newSymbols] = await Promise.all([
      this.skeletonGenerator.generateStructureJson(filePath, oldContent),
      this.skeletonGenerator.generateStructureJson(filePath, newContent)
    ]);
    
    // Compute semantic changes
    const semanticChanges = this.computeSemanticChanges(
      oldSymbols, newSymbols, hunks, oldContent, newContent
    );
    
    const summary = PatienceDiff.summarize(hunks);
    
    return { hunks, semanticChanges, summary };
  }
  
  private computeSemanticChanges(
    oldSymbols: SymbolInfo[],
    newSymbols: SymbolInfo[],
    hunks: DiffHunk[],
    oldContent: string,
    newContent: string
  ): SemanticChange[] {
    const changes: SemanticChange[] = [];
    
    // Create lookup maps
    const oldByName = new Map(oldSymbols.map(s => [s.name, s]));
    const newByName = new Map(newSymbols.map(s => [s.name, s]));
    
    // Detect removals and modifications
    for (const [name, oldSym] of oldByName) {
      const newSym = newByName.get(name);
      
      if (!newSym) {
        // Symbol removed - check if it might be a rename or move
        const possibleRename = this.findPossibleRename(oldSym, newSymbols, oldContent, newContent);
        
        if (possibleRename) {
          changes.push({
            type: 'rename',
            symbolType: this.mapSymbolType(oldSym.type),
            name: possibleRename.name,
            oldName: name,
            oldLocation: { start: oldSym.range.startLine, end: oldSym.range.endLine },
            newLocation: { start: possibleRename.range.startLine, end: possibleRename.range.endLine },
            hunks: this.getRelevantHunks(hunks, oldSym, possibleRename)
          });
          newByName.delete(possibleRename.name); // Don't count as addition
        } else {
          changes.push({
            type: 'remove',
            symbolType: this.mapSymbolType(oldSym.type),
            name,
            oldLocation: { start: oldSym.range.startLine, end: oldSym.range.endLine },
            hunks: this.getHunksForRange(hunks, oldSym.range.startLine, oldSym.range.endLine, 'old')
          });
        }
      } else {
        // Check if modified
        if (this.isModified(oldSym, newSym, oldContent, newContent)) {
          changes.push({
            type: 'modify',
            symbolType: this.mapSymbolType(oldSym.type),
            name,
            oldLocation: { start: oldSym.range.startLine, end: oldSym.range.endLine },
            newLocation: { start: newSym.range.startLine, end: newSym.range.endLine },
            hunks: this.getRelevantHunks(hunks, oldSym, newSym)
          });
        }
        newByName.delete(name);
      }
    }
    
    // Remaining new symbols are additions
    for (const [name, newSym] of newByName) {
      changes.push({
        type: 'add',
        symbolType: this.mapSymbolType(newSym.type),
        name,
        newLocation: { start: newSym.range.startLine, end: newSym.range.endLine },
        hunks: this.getHunksForRange(hunks, newSym.range.startLine, newSym.range.endLine, 'new')
      });
    }
    
    return changes;
  }
  
  private findPossibleRename(
    oldSym: SymbolInfo,
    newSymbols: SymbolInfo[],
    oldContent: string,
    newContent: string
  ): SymbolInfo | null {
    // Look for a new symbol of the same type with similar structure
    const oldBody = oldContent.substring(oldSym.range.startByte, oldSym.range.endByte);
    
    for (const newSym of newSymbols) {
      if (newSym.type !== oldSym.type) continue;
      
      const newBody = newContent.substring(newSym.range.startByte, newSym.range.endByte);
      
      // Check if bodies are similar (ignoring the name itself)
      const oldNormalized = this.normalizeBody(oldBody, oldSym.name);
      const newNormalized = this.normalizeBody(newBody, newSym.name);
      
      const similarity = this.computeSimilarity(oldNormalized, newNormalized);
      if (similarity > 0.8) {
        return newSym;
      }
    }
    
    return null;
  }
  
  private normalizeBody(body: string, symbolName: string): string {
    // Remove the symbol name and normalize whitespace
    return body
      .replace(new RegExp(symbolName, 'g'), '__SYMBOL__')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  private computeSimilarity(a: string, b: string): number {
    // Simple Jaccard similarity on tokens
    const tokensA = new Set(a.split(/\s+/));
    const tokensB = new Set(b.split(/\s+/));
    
    const intersection = new Set([...tokensA].filter(t => tokensB.has(t)));
    const union = new Set([...tokensA, ...tokensB]);
    
    return intersection.size / union.size;
  }
  
  private isModified(
    oldSym: SymbolInfo,
    newSym: SymbolInfo,
    oldContent: string,
    newContent: string
  ): boolean {
    const oldBody = oldContent.substring(oldSym.range.startByte, oldSym.range.endByte);
    const newBody = newContent.substring(newSym.range.startByte, newSym.range.endByte);
    return oldBody !== newBody;
  }
  
  private mapSymbolType(type: string): SemanticChange['symbolType'] {
    switch (type) {
      case 'function':
      case 'method':
        return 'function';
      case 'class':
        return 'class';
      case 'interface':
      case 'type_alias':
        return 'interface';
      case 'variable':
        return 'variable';
      case 'import':
        return 'import';
      default:
        return 'unknown';
    }
  }
  
  private getRelevantHunks(hunks: DiffHunk[], oldSym: SymbolInfo, newSym: SymbolInfo): DiffHunk[] {
    return hunks.filter(h => 
      (h.oldStart <= oldSym.range.endLine && h.oldEnd >= oldSym.range.startLine) ||
      (h.newStart <= newSym.range.endLine && h.newEnd >= newSym.range.startLine)
    );
  }
  
  private getHunksForRange(
    hunks: DiffHunk[], 
    start: number, 
    end: number, 
    side: 'old' | 'new'
  ): DiffHunk[] {
    return hunks.filter(h => {
      if (side === 'old') {
        return h.oldStart <= end && h.oldEnd >= start;
      } else {
        return h.newStart <= end && h.newEnd >= start;
      }
    });
  }
}
```

#### Comparison: Myers vs Patience Diff

| Scenario | Myers Output | Patience Output |
|----------|-------------|-----------------|
| Function move | Delete(20 lines) + Add(20 lines) | Move(functionName) |
| Variable rename | Scattered single-line changes | Rename(oldName → newName) |
| Add blank line | Insert(blank) pollutes diff | Grouped with nearby change |
| Reorder methods | Complex interleavings | Clear sequential moves |

#### Trade-offs

| Aspect | Benefit | Cost |
|--------|---------|------|
| Readability | Much cleaner diffs | +20% code complexity |
| Accuracy | Semantic grouping | Slightly slower (2-3x) |
| Compatibility | Drop-in replacement | Minor API changes |

---

## Implementation Plan

### Phase 1: Foundation (Weeks 1-2)
- [ ] Create `IFileSystem` interface and implementations
- [ ] Set up `ServiceContainer` with DI pattern
- [ ] Migrate `Editor.ts`, `Context.ts` to use abstraction

### Phase 2: Search Infrastructure (Weeks 3-4)
- [ ] Implement `TrigramIndexBuilder`
- [ ] Implement `BM25FRanker`
- [ ] Create `EnhancedSearchEngine` with fallback to legacy

### Phase 3: Diff Enhancement (Week 5)
- [ ] Implement `PatienceDiff` core algorithm
- [ ] Add `AstAwareDiff` for semantic grouping
- [ ] Update `EditorEngine` to use new diff

### Phase 4: Integration & Testing (Week 6)
- [ ] Migrate remaining modules to `IFileSystem`
- [ ] Performance benchmarks
- [ ] Documentation updates

## Consequences

### Positive
- **Testability**: Unit tests can run in <1s with `MemoryFileSystem`
- **Search Quality**: 100-300x faster with better relevance ranking
- **Diff Quality**: Semantic diffs improve code review experience
- **Maintainability**: Clear separation of concerns

### Negative
- **Complexity**: +2000 LoC of new abstraction code
- **Memory**: Search index requires 50-100MB for large codebases
- **Migration**: Internal API changes require careful testing

### Risks
- Index staleness for rapidly changing files
- Memory pressure on constrained environments
- Patience diff edge cases with highly similar code

## References

- [BM25F: BM25 with Field Weighting](https://www.microsoft.com/en-us/research/publication/some-simple-effective-approximations-to-the-2-poisson-model-for-probabilistic-weighted-retrieval/)
- [Patience Diff Algorithm](https://bramcohen.livejournal.com/73318.html)
- [Trigram Indexing for Code Search](https://swtch.com/~rsc/regexp/regexp4.html)
