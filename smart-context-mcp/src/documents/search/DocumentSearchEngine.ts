import { BM25FRanking } from "../../engine/Ranking.js";
import { SearchEngine } from "../../engine/Search.js";
import { DocumentChunkRepository, StoredDocumentChunk } from "../../indexing/DocumentChunkRepository.js";
import { EmbeddingRepository } from "../../indexing/EmbeddingRepository.js";
import { DocumentIndexer } from "../../indexing/DocumentIndexer.js";
import { EmbeddingConfig, DocumentKind } from "../../types.js";
import { EmbeddingProviderFactory } from "../../embeddings/EmbeddingProviderFactory.js";

export interface DocumentSearchOptions {
    maxResults?: number;
    maxCandidates?: number;
    maxChunkCandidates?: number;
    maxVectorCandidates?: number;
    maxEvidenceSections?: number;
    maxEvidenceChars?: number;
    includeEvidence?: boolean;
    snippetLength?: number;
    rrfK?: number;
    rrfDepth?: number;
    useMmr?: boolean;
    mmrLambda?: number;
    maxChunksEmbeddedPerRequest?: number;
    maxEmbeddingTimeMs?: number;
    embedding?: EmbeddingConfig;
}

export interface DocumentSearchSection {
    id: string;
    filePath: string;
    kind: DocumentKind;
    sectionPath: string[];
    heading: string | null;
    headingLevel: number | null;
    range: { startLine: number; endLine: number };
    preview: string;
    scores: { bm25: number; vector?: number; final: number };
}

export interface DocumentSearchResponse {
    query: string;
    results: DocumentSearchSection[];
    evidence?: DocumentSearchSection[];
    degraded?: boolean;
    provider?: { name: string; model: string; dims: number } | null;
    stats: {
        candidateFiles: number;
        candidateChunks: number;
        vectorEnabled: boolean;
        mmrApplied: boolean;
    };
}

export class DocumentSearchEngine {
    private readonly bm25 = new BM25FRanking();

    constructor(
        private readonly searchEngine: SearchEngine,
        private readonly documentIndexer: DocumentIndexer,
        private readonly chunkRepository: DocumentChunkRepository,
        private readonly embeddingRepository: EmbeddingRepository,
        private readonly embeddingFactory: EmbeddingProviderFactory
    ) {}

    public async search(query: string, options: DocumentSearchOptions = {}): Promise<DocumentSearchResponse> {
        if (!query || !query.trim()) {
            return {
                query,
                results: [],
                evidence: [],
                degraded: false,
                provider: null,
                stats: {
                    candidateFiles: 0,
                    candidateChunks: 0,
                    vectorEnabled: false,
                    mmrApplied: false
                }
            };
        }

        const maxResults = options.maxResults ?? 8;
        const maxCandidates = options.maxCandidates ?? 60;
        const maxChunkCandidates = options.maxChunkCandidates ?? 400;
        const maxVectorCandidates = options.maxVectorCandidates ?? 60;
        const maxEvidenceSections = options.maxEvidenceSections ?? Math.max(maxResults * 3, 12);
        const maxEvidenceChars = options.maxEvidenceChars ?? 8000;
        const includeEvidence = options.includeEvidence ?? true;
        const snippetLength = options.snippetLength ?? 240;
        const rrfK = options.rrfK ?? 60;
        const rrfDepth = options.rrfDepth ?? 200;
        const useMmr = options.useMmr !== false;
        const mmrLambda = options.mmrLambda ?? 0.7;
        const maxChunksEmbeddedPerRequest = options.maxChunksEmbeddedPerRequest ?? 32;
        const maxEmbeddingTimeMs = options.maxEmbeddingTimeMs ?? 2500;

        const candidateFiles = await this.collectCandidateFiles(query, maxCandidates);
        let chunks = await this.collectChunks(candidateFiles);
        const initialChunkCount = chunks.length;

        if (chunks.length > maxChunkCandidates) {
            const queryTokens = tokenize(query);
            chunks = chunks
                .map(chunk => ({
                    chunk,
                    score: quickMatchScore(chunk.text, queryTokens)
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, maxChunkCandidates)
                .map(entry => entry.chunk);
        }

        if (chunks.length === 0) {
            return {
                query,
                results: [],
                evidence: includeEvidence ? [] : undefined,
                degraded: false,
                provider: null,
                stats: {
                    candidateFiles: candidateFiles.length,
                    candidateChunks: 0,
                    vectorEnabled: false,
                    mmrApplied: false
                }
            };
        }

        const bm25Documents = chunks.map(chunk => ({
            id: chunk.id,
            text: chunk.text,
            score: 0,
            filePath: chunk.filePath
        }));
        const bm25Ranked = this.bm25.rank(bm25Documents, query);
        const bm25ScoreMap = new Map(bm25Ranked.map(doc => [doc.id, doc.score ?? 0]));
        const bm25RankMap = buildRankMap(bm25Ranked.map(doc => doc.id));

        const provider = await this.resolveEmbeddingProvider(options.embedding);
        let vectorEnabled = provider.provider !== "disabled";
        let vectorScores = new Map<string, number>();
        let vectorRankMap = new Map<string, number>();
        let degraded = false;

        if (vectorEnabled) {
            const vectorCandidates = bm25Ranked.slice(0, Math.min(maxVectorCandidates, bm25Ranked.length));
            const candidateChunks = vectorCandidates
                .map(doc => chunks.find(chunk => chunk.id === doc.id))
                .filter((chunk): chunk is StoredDocumentChunk => Boolean(chunk));

            try {
                const embeddingResult = await this.ensureEmbeddings(query, candidateChunks, provider, {
                    maxChunks: maxChunksEmbeddedPerRequest,
                    maxTimeMs: maxEmbeddingTimeMs
                });

                degraded = embeddingResult.degraded;
                vectorScores = embeddingResult.scores;
                const vectorRanked = Array.from(vectorScores.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, rrfDepth);
                vectorRankMap = buildRankMap(vectorRanked.map(([id]) => id));
            } catch {
                degraded = true;
                vectorEnabled = false;
                vectorScores = new Map();
                vectorRankMap = new Map();
            }
        }

        const rrfScores = new Map<string, number>();
        for (const [docId, rank] of bm25RankMap) {
            if (rank > rrfDepth) continue;
            rrfScores.set(docId, (rrfScores.get(docId) ?? 0) + 1 / (rrfK + rank));
        }
        for (const [docId, rank] of vectorRankMap) {
            if (rank > rrfDepth) continue;
            rrfScores.set(docId, (rrfScores.get(docId) ?? 0) + 1 / (rrfK + rank));
        }

        const scoredSections = chunks.map(chunk => {
            const bm25Score = bm25ScoreMap.get(chunk.id) ?? 0;
            const vectorScore = vectorScores.get(chunk.id);
            const finalScore = vectorEnabled ? (rrfScores.get(chunk.id) ?? 0) : bm25Score;
            return {
                chunk,
                scores: {
                    bm25: bm25Score,
                    vector: vectorScore,
                    final: finalScore
                }
            };
        }).sort((a, b) => b.scores.final - a.scores.final);

        const similarityCache = new Map<string, number>();
        const tokenCache = new Map<string, Set<string>>();
        const vectorCache = vectorEnabled ? new Map<string, Float32Array>() : null;
        if (vectorEnabled && vectorScores.size > 0) {
            for (const chunk of chunks) {
                const stored = this.embeddingRepository.getEmbedding(chunk.id, provider.provider, provider.model);
                if (stored?.vector) {
                    vectorCache?.set(chunk.id, stored.vector);
                }
            }
        }
        for (const chunk of chunks) {
            tokenCache.set(chunk.id, new Set(tokenize(chunk.text)));
        }

        const ordered = useMmr
            ? applyMmr(scoredSections, mmrLambda, maxEvidenceSections, (a, b) => {
                const key = `${a}|${b}`;
                if (similarityCache.has(key)) return similarityCache.get(key) ?? 0;
                const similarity = computeSimilarity(a, b, vectorCache, tokenCache);
                similarityCache.set(key, similarity);
                return similarity;
            })
            : scoredSections;

        const results = ordered.slice(0, maxResults).map(entry => toSearchSection(entry.chunk, entry.scores, snippetLength));
        const evidence = includeEvidence
            ? limitEvidence(ordered.map(entry => toSearchSection(entry.chunk, entry.scores, snippetLength)), maxEvidenceSections, maxEvidenceChars)
            : undefined;

        return {
            query,
            results,
            evidence,
            degraded,
            provider: vectorEnabled ? { name: provider.provider, model: provider.model, dims: provider.dims } : null,
            stats: {
                candidateFiles: candidateFiles.length,
                candidateChunks: initialChunkCount,
                vectorEnabled,
                mmrApplied: useMmr
            }
        };
    }

    private async collectCandidateFiles(query: string, maxCandidates: number): Promise<string[]> {
        const scoutResults = await this.searchEngine.scout({
            query,
            includeGlobs: ["**/*.md", "**/*.mdx"],
            maxResults: maxCandidates,
            groupByFile: true,
            deduplicateByContent: true
        });

        const paths = scoutResults.map(result => result.filePath).filter(Boolean);
        const unique = Array.from(new Set(paths));
        if (unique.length > 0) return unique;

        const filenameFallback = await this.searchEngine.searchFilenames(query, { maxResults: maxCandidates });
        return Array.from(new Set(filenameFallback.map(result => result.path)));
    }

    private async collectChunks(filePaths: string[]): Promise<StoredDocumentChunk[]> {
        const chunks: StoredDocumentChunk[] = [];
        for (const filePath of filePaths) {
            let stored = this.chunkRepository.listChunksForFile(filePath);
            if (stored.length === 0) {
                try {
                    await this.documentIndexer.indexFile(filePath);
                    stored = this.chunkRepository.listChunksForFile(filePath);
                } catch {
                    stored = [];
                }
            }
            chunks.push(...stored);
        }
        return chunks;
    }

    private async ensureEmbeddings(
        query: string,
        chunks: StoredDocumentChunk[],
        provider: { provider: string; model: string; dims: number; normalize: boolean; embed(texts: string[]): Promise<Float32Array[]> },
        limits: { maxChunks: number; maxTimeMs: number }
    ): Promise<{ scores: Map<string, number>; degraded: boolean }> {
        const [queryVector] = await provider.embed([query]);
        if (!queryVector) {
            return { scores: new Map(), degraded: true };
        }
        const scores = new Map<string, number>();
        const missing: StoredDocumentChunk[] = [];

        for (const chunk of chunks) {
            const stored = this.embeddingRepository.getEmbedding(chunk.id, provider.provider, provider.model);
            if (stored?.vector && stored.vector.length > 0) {
                if (provider.dims === 0) {
                    provider.dims = stored.dims;
                }
                scores.set(chunk.id, cosineSimilarity(stored.vector, queryVector));
            } else {
                missing.push(chunk);
            }
        }

        if (missing.length === 0) {
            return { scores, degraded: false };
        }

        const startedAt = Date.now();
        let degraded = false;
        const limited = missing.slice(0, limits.maxChunks);
        if (missing.length > limits.maxChunks) {
            degraded = true;
        }

        const batchSize = Math.max(1, Math.min(limits.maxChunks, 16));
        for (let i = 0; i < limited.length; i += batchSize) {
            const elapsed = Date.now() - startedAt;
            if (elapsed > limits.maxTimeMs) {
                degraded = true;
                break;
            }
            const batch = limited.slice(i, i + batchSize);
            const vectors = await provider.embed(batch.map(chunk => chunk.text));
            for (let idx = 0; idx < batch.length; idx += 1) {
                const chunk = batch[idx];
                const vector = vectors[idx];
                if (!vector) continue;
                if (provider.dims === 0) {
                    provider.dims = vector.length;
                }
                this.embeddingRepository.upsertEmbedding(chunk.id, {
                    provider: provider.provider,
                    model: provider.model,
                    dims: vector.length,
                    vector,
                    norm: l2Norm(vector)
                });
                scores.set(chunk.id, cosineSimilarity(vector, queryVector));
            }
        }

        return { scores, degraded };
    }

    private async resolveEmbeddingProvider(override?: EmbeddingConfig) {
        if (!override) {
            return this.embeddingFactory.getProvider();
        }
        const merged = mergeEmbeddingConfig(this.embeddingFactory.getConfig(), override);
        const factory = new EmbeddingProviderFactory(merged);
        return factory.getProvider();
    }
}

function toSearchSection(chunk: StoredDocumentChunk, scores: { bm25: number; vector?: number; final: number }, snippetLength: number): DocumentSearchSection {
    const preview = chunk.text.length > snippetLength
        ? `${chunk.text.slice(0, Math.max(1, snippetLength - 1))}…`
        : chunk.text;
    return {
        id: chunk.id,
        filePath: chunk.filePath,
        kind: chunk.kind,
        sectionPath: chunk.sectionPath,
        heading: chunk.heading,
        headingLevel: chunk.headingLevel,
        range: { startLine: chunk.range.startLine, endLine: chunk.range.endLine },
        preview,
        scores
    };
}

function buildRankMap(ids: string[]): Map<string, number> {
    const map = new Map<string, number>();
    ids.forEach((id, idx) => map.set(id, idx + 1));
    return map;
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length > 0);
}

function quickMatchScore(text: string, tokens: string[]): number {
    if (tokens.length === 0) return 0;
    const haystack = text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
        if (token && haystack.includes(token)) score += 1;
    }
    return score;
}

function applyMmr<T extends { chunk: StoredDocumentChunk; scores: { final: number } }>(
    candidates: T[],
    lambda: number,
    maxResults: number,
    similarityFn: (aId: string, bId: string) => number
): T[] {
    const selected: T[] = [];
    const remaining = [...candidates];

    while (selected.length < maxResults && remaining.length > 0) {
        let bestIndex = 0;
        let bestScore = -Infinity;

        for (let i = 0; i < remaining.length; i += 1) {
            const candidate = remaining[i];
            const rel = candidate.scores.final;
            let maxSim = 0;
            for (const chosen of selected) {
                const sim = similarityFn(candidate.chunk.id, chosen.chunk.id);
                if (sim > maxSim) maxSim = sim;
            }
            const score = lambda * rel - (1 - lambda) * maxSim;
            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }

        selected.push(remaining.splice(bestIndex, 1)[0]);
    }

    return selected.concat(remaining);
}

function computeSimilarity(
    aId: string,
    bId: string,
    vectorCache: Map<string, Float32Array> | null,
    tokenCache: Map<string, Set<string>>
): number {
    const vectorA = vectorCache?.get(aId);
    const vectorB = vectorCache?.get(bId);
    if (vectorA && vectorB) {
        return cosineSimilarity(vectorA, vectorB);
    }
    const tokensA = tokenCache.get(aId);
    const tokensB = tokenCache.get(bId);
    if (!tokensA || !tokensB) return 0;
    return jaccard(tokensA, tokensB);
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
        if (b.has(item)) intersection += 1;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length === 0 || b.length === 0) return 0;
    const length = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function l2Norm(vector: Float32Array): number {
    let sum = 0;
    for (const v of vector) {
        sum += v * v;
    }
    return Math.sqrt(sum);
}

function limitEvidence(
    sections: DocumentSearchSection[],
    maxSections: number,
    maxChars: number
): DocumentSearchSection[] {
    const results: DocumentSearchSection[] = [];
    let totalChars = 0;
    for (const section of sections) {
        if (results.length >= maxSections) break;
        const next = totalChars + section.preview.length;
        if (next > maxChars) break;
        results.push(section);
        totalChars = next;
    }
    return results;
}

function mergeEmbeddingConfig(base: EmbeddingConfig, override: EmbeddingConfig): EmbeddingConfig {
    return {
        ...base,
        ...override,
        openai: {
            ...base.openai,
            ...override.openai
        },
        local: {
            ...base.local,
            ...override.local
        }
    };
}
