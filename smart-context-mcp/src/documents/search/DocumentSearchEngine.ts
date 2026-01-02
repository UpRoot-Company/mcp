import { BM25FRanking } from "../../engine/Ranking.js";
import { SearchEngine } from "../../engine/Search.js";
import { DocumentChunkRepository, StoredDocumentChunk } from "../../indexing/DocumentChunkRepository.js";
import { EmbeddingRepository } from "../../indexing/EmbeddingRepository.js";
import { DocumentIndexer } from "../../indexing/DocumentIndexer.js";
import { EmbeddingConfig, DocumentKind } from "../../types.js";
import { EmbeddingProviderFactory } from "../../embeddings/EmbeddingProviderFactory.js";
import * as path from "path";
import { EmbeddingTimeoutError } from "../../embeddings/EmbeddingQueue.js";
import { LRUCache } from "lru-cache";
import * as crypto from "crypto";
import { EvidencePackRepository, computeRootFingerprint, type StoredEvidencePack } from "../../indexing/EvidencePackRepository.js";
import { buildDeterministicPreview } from "../summary/DeterministicSummarizer.js";
import { metrics } from "../../utils/MetricsCollector.js";

export interface DocumentSearchOptions {
    scope?: "docs" | "project" | "all";
    output?: "full" | "compact" | "pack_only";
    packId?: string;
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
    includeComments?: boolean;
    includeLogs?: boolean;
    includeMetrics?: boolean;
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
    pack?: {
        packId: string;
        hit: boolean;
        createdAt: number;
        expiresAt?: number;
    };
    degraded?: boolean;
    reason?: string;
    reasons?: string[];
    provider?: { name: string; model: string; dims: number } | null;
    stats: {
        candidateFiles: number;
        candidateChunks: number;
        vectorEnabled: boolean;
        mmrApplied: boolean;
        evidenceSections: number;
        evidenceChars: number;
        evidenceTruncated: boolean;
    };
}

export class DocumentSearchEngine {
    private readonly bm25 = new BM25FRanking();
    private readonly packCache: LRUCache<string, { response: DocumentSearchResponse; createdAt: number; expiresAt?: number; staleCheckItems: Array<{ chunkId: string; snapshot?: { contentHash?: string } }> }>;

    constructor(
        private readonly searchEngine: SearchEngine,
        private readonly documentIndexer: DocumentIndexer,
        private readonly chunkRepository: DocumentChunkRepository,
        private readonly embeddingRepository: EmbeddingRepository,
        private readonly embeddingFactory: EmbeddingProviderFactory,
        private readonly rootPath: string,
        private readonly symbolIndex?: { getSymbolsForFile(filePath: string): Promise<unknown> },
        private readonly evidencePacks?: EvidencePackRepository
    ) {
        const max = Number.parseInt(process.env.SMART_CONTEXT_EVIDENCE_PACK_CACHE_SIZE ?? "100", 10);
        this.packCache = new LRUCache({ max: Number.isFinite(max) && max > 0 ? max : 100 });
    }

    public async search(query: string, options: DocumentSearchOptions = {}): Promise<DocumentSearchResponse> {
        const stopTotal = metrics.startTimer("docs.search.total_ms");
        const output = options.output ?? "full";
        const packTtlMs = Number.parseInt(process.env.SMART_CONTEXT_EVIDENCE_PACK_TTL_MS ?? "86400000", 10); // 24h
        const scope = options.scope ?? "all";
        const includeLogs = options.includeLogs === true;
        const includeMetrics = options.includeMetrics === true;

        try {
            if (!query || !query.trim()) {
                return {
                    query,
                    results: [],
                    evidence: [],
                    degraded: false,
                    reason: undefined,
                    reasons: undefined,
                    provider: null,
                    stats: {
                        candidateFiles: 0,
                        candidateChunks: 0,
                        vectorEnabled: false,
                        mmrApplied: false,
                        evidenceSections: 0,
                        evidenceChars: 0,
                        evidenceTruncated: false
                    }
                };
            }

        const maxResults = options.maxResults ?? (output === "compact" ? 6 : 8);
        const maxCandidates = options.maxCandidates ?? 60;
        const maxChunkCandidates = options.maxChunkCandidates ?? 400;
        const maxVectorCandidates = options.maxVectorCandidates ?? 60;
        const maxEvidenceSections = options.maxEvidenceSections ?? (output === "compact" ? Math.max(maxResults * 2, 8) : Math.max(maxResults * 3, 12));
        const maxEvidenceChars = options.maxEvidenceChars ?? (output === "compact" ? 2200 : 8000);
        const includeEvidence = options.includeEvidence ?? (output === "full");
        const snippetLength = options.snippetLength ?? (output === "compact" ? 120 : 240);
        const rrfK = options.rrfK ?? 60;
        const rrfDepth = options.rrfDepth ?? 200;
        const useMmr = options.useMmr !== false;
        const mmrLambda = options.mmrLambda ?? 0.7;
        const maxChunksEmbeddedPerRequest = options.maxChunksEmbeddedPerRequest ?? 32;
        const maxEmbeddingTimeMs = options.maxEmbeddingTimeMs ?? 2500;
        const degradationReasons: string[] = [];

        const effectivePackId = options.packId ?? computePackId(query, {
            output,
            maxResults,
            maxCandidates,
            maxChunkCandidates,
            maxVectorCandidates,
            maxEvidenceSections,
            maxEvidenceChars,
            includeEvidence,
            snippetLength,
            rrfK,
            rrfDepth,
            useMmr,
            mmrLambda,
            maxChunksEmbeddedPerRequest,
            maxEmbeddingTimeMs,
            includeComments: options.includeComments === true,
            includeLogs,
            includeMetrics,
            scope,
            embedding: options.embedding ?? null
        });

        const cached = this.packCache.get(effectivePackId);
        if (cached) {
            const now = Date.now();
            if (!cached.expiresAt || cached.expiresAt > now) {
                const stale = await this.isPackStale(cached.staleCheckItems ?? []);
                if (!stale) {
                    return {
                        ...cached.response,
                        pack: {
                            packId: effectivePackId,
                            hit: true,
                            createdAt: cached.createdAt,
                            expiresAt: cached.expiresAt
                        }
                    };
                }
                this.packCache.delete(effectivePackId);
            }
            this.packCache.delete(effectivePackId);
        }

        // Persistent pack lookup (Phase 2): enables reuse across engine instances.
        if (this.evidencePacks) {
            const stored = this.evidencePacks.getPack(effectivePackId);
            if (stored && stored.rootFingerprint === computeRootFingerprint(this.rootPath)) {
                const stale = await this.isPackStale(stored.items);
                if (!stale) {
                const responseFromDb = this.hydrateResponseFromPack(stored, output, includeEvidence);
                const createdAt = stored.createdAt;
                const expiresAt = stored.expiresAt;
                const staleCheckItems = (stored.items ?? [])
                    .map(item => ({ chunkId: item.chunkId, snapshot: { contentHash: item.snapshot?.contentHash } }))
                    .filter(item => Boolean(item.snapshot?.contentHash));
                this.packCache.set(effectivePackId, { response: responseFromDb, createdAt, expiresAt, staleCheckItems });
                return {
                    ...responseFromDb,
                    pack: { packId: effectivePackId, hit: true, createdAt, expiresAt }
                };
            }
        }
        }

        const candidateFiles = await this.collectCandidateFiles(
            query,
            maxCandidates,
            options.includeComments === true,
            scope,
            includeLogs,
            includeMetrics
        );
        metrics.gauge("docs.search.candidate_files", candidateFiles.length);
        let chunks = await this.collectChunks(candidateFiles, options.includeComments === true);
        const initialChunkCount = chunks.length;
        metrics.gauge("docs.search.candidate_chunks", initialChunkCount);

        if (chunks.length > maxChunkCandidates) {
            degradationReasons.push("budget_exceeded");
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
            const response: DocumentSearchResponse = {
                query,
                results: [],
                evidence: includeEvidence ? [] : undefined,
                degraded: false,
                reason: undefined,
                reasons: undefined,
                provider: null,
                stats: {
                    candidateFiles: candidateFiles.length,
                    candidateChunks: 0,
                    vectorEnabled: false,
                    mmrApplied: false,
                    evidenceSections: 0,
                    evidenceChars: 0,
                    evidenceTruncated: false
                }
            };
            const createdAt = Date.now();
            const expiresAt = Number.isFinite(packTtlMs) && packTtlMs > 0 ? createdAt + packTtlMs : undefined;
            this.packCache.set(effectivePackId, { response, createdAt, expiresAt, staleCheckItems: [] });
            if (this.evidencePacks) {
                try {
                    this.evidencePacks.upsertPack({
                        packId: effectivePackId,
                        query,
                        createdAt,
                        expiresAt,
                        rootFingerprint: computeRootFingerprint(this.rootPath),
                        options: { ...options, output, includeEvidence, snippetLength, maxEvidenceChars, maxEvidenceSections, maxResults },
                        meta: { degraded: response.degraded, reason: response.reason, reasons: response.reasons, provider: response.provider, stats: response.stats as any },
                        items: []
                    });
                } catch {
                    // best-effort
                }
            }
            return {
                ...response,
                pack: { packId: effectivePackId, hit: false, createdAt, expiresAt }
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
        const metricsBoost = includeMetrics
            ? Number.parseFloat(process.env.SMART_CONTEXT_METRICS_SCORE_BOOST ?? "0.12")
            : 0;

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
                if (embeddingResult.reasons.length > 0) {
                    degradationReasons.push(...embeddingResult.reasons);
                }
                vectorScores = embeddingResult.scores;
                const vectorRanked = Array.from(vectorScores.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, rrfDepth);
                vectorRankMap = buildRankMap(vectorRanked.map(([id]) => id));
            } catch (err: any) {
                degraded = true;
                if (err instanceof EmbeddingTimeoutError) {
                    degradationReasons.push("embedding_timeout");
                } else {
                    degradationReasons.push("vector_disabled");
                }
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
            const baseScore = vectorEnabled ? (rrfScores.get(chunk.id) ?? 0) : bm25Score;
            const finalScore = (metricsBoost > 0 && isMetricsPath(chunk.filePath))
                ? baseScore * (1 + metricsBoost)
                : baseScore;
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
        const evidenceCandidates = includeEvidence
            ? ordered.map(entry => toSearchSection(entry.chunk, entry.scores, snippetLength))
            : [];
        const evidence = includeEvidence
            ? limitEvidence(evidenceCandidates, maxEvidenceSections, maxEvidenceChars)
            : undefined;

        // Phase 3: store/reuse deterministic previews in chunk_summaries to reduce repeated payload work.
        if (this.evidencePacks) {
            const byId = new Map(chunks.map(c => [c.id, c]));
            this.fillPreviewsFromSummaries(results, byId, query, snippetLength);
            if (Array.isArray(evidence)) {
                this.fillPreviewsFromSummaries(evidence, byId, query, snippetLength);
            }
        }

        const evidenceChars = (evidence ?? []).reduce((sum, section) => sum + (section.preview?.length ?? 0), 0);
        const evidenceTruncated = includeEvidence && evidence != null && evidence.length < evidenceCandidates.length;
        if (evidenceTruncated) {
            degradationReasons.push("evidence_truncated");
        }

        const uniqueReasons = Array.from(new Set(degradationReasons.filter(Boolean)));
        const degradedAny = degraded || uniqueReasons.length > 0;
        const reason = uniqueReasons.length > 0 ? uniqueReasons[0] : undefined;
        const reasons = uniqueReasons.length > 1 ? uniqueReasons : undefined;

        const response: DocumentSearchResponse = {
            query,
            results: output === "pack_only" ? results.map(r => ({ ...r, preview: "" })) : results,
            evidence: includeEvidence
                ? (output === "pack_only"
                    ? (evidence ?? []).map(e => ({ ...e, preview: "" }))
                    : evidence)
                : undefined,
            degraded: degradedAny,
            reason,
            reasons,
            provider: vectorEnabled ? { name: provider.provider, model: provider.model, dims: provider.dims } : null,
            stats: {
                candidateFiles: candidateFiles.length,
                candidateChunks: initialChunkCount,
                vectorEnabled,
                mmrApplied: useMmr,
                evidenceSections: evidence?.length ?? 0,
                evidenceChars,
                evidenceTruncated
            }
        };
        if (degradedAny) {
            metrics.inc("docs.search.degraded_total");
        }

        const createdAt = Date.now();
        const expiresAt = Number.isFinite(packTtlMs) && packTtlMs > 0 ? createdAt + packTtlMs : undefined;
        const staleCheckItems = this.buildStaleCheckItems(results, evidence, includeEvidence, chunks);
        this.packCache.set(effectivePackId, { response, createdAt, expiresAt, staleCheckItems });
        if (this.evidencePacks) {
            try {
                const storedItems = this.toStoredItems(results, evidence, includeEvidence, chunks, bm25ScoreMap, vectorScores, vectorEnabled);
                this.evidencePacks.upsertPack({
                    packId: effectivePackId,
                    query,
                    createdAt,
                    expiresAt,
                    rootFingerprint: computeRootFingerprint(this.rootPath),
                    options: { ...options, output, includeEvidence, snippetLength, maxEvidenceChars, maxEvidenceSections, maxResults },
                    meta: { degraded: response.degraded, reason: response.reason, reasons: response.reasons, provider: response.provider, stats: response.stats as any },
                    items: storedItems
                });
            } catch {
                // best-effort
            }
        }
        return {
            ...response,
            pack: { packId: effectivePackId, hit: false, createdAt, expiresAt }
        };
        } finally {
            stopTotal();
        }
    }

    private buildStaleCheckItems(
        results: DocumentSearchSection[],
        evidence: DocumentSearchSection[] | undefined,
        includeEvidence: boolean,
        chunks: StoredDocumentChunk[]
    ): Array<{ chunkId: string; snapshot?: { contentHash?: string } }> {
        const byId = new Map(chunks.map(c => [c.id, c]));
        const out: Array<{ chunkId: string; snapshot?: { contentHash?: string } }> = [];
        for (const r of results) {
            const chunk = byId.get(r.id);
            if (!chunk?.contentHash) continue;
            out.push({ chunkId: r.id, snapshot: { contentHash: chunk.contentHash } });
        }
        if (includeEvidence && Array.isArray(evidence)) {
            for (const e of evidence) {
                const chunk = byId.get(e.id);
                if (!chunk?.contentHash) continue;
                out.push({ chunkId: e.id, snapshot: { contentHash: chunk.contentHash } });
            }
        }
        return out;
    }

    private hydrateResponseFromPack(
        pack: StoredEvidencePack,
        output: "full" | "compact" | "pack_only",
        includeEvidence: boolean
    ): DocumentSearchResponse {
        const items = pack.items ?? [];
        const results = items.filter(i => i.role === "result").map(i => ({
            id: i.chunkId,
            filePath: i.filePath,
            kind: i.kind,
            sectionPath: i.sectionPath,
            heading: i.heading,
            headingLevel: i.headingLevel,
            range: i.range,
            preview: output === "pack_only" ? "" : i.preview,
            scores: i.scores ?? { bm25: 0, final: 0 }
        }));
        const evidence = includeEvidence
            ? items.filter(i => i.role === "evidence").map(i => ({
                id: i.chunkId,
                filePath: i.filePath,
                kind: i.kind,
                sectionPath: i.sectionPath,
                heading: i.heading,
                headingLevel: i.headingLevel,
                range: i.range,
                preview: output === "pack_only" ? "" : i.preview,
                scores: i.scores ?? { bm25: 0, final: 0 }
            }))
            : undefined;

        const meta = pack.meta ?? {};
        const fallbackStats: DocumentSearchResponse["stats"] = {
            candidateFiles: 0,
            candidateChunks: 0,
            vectorEnabled: false,
            mmrApplied: false,
            evidenceSections: evidence?.length ?? 0,
            evidenceChars: (evidence ?? []).reduce((sum: number, s: any) => sum + (s.preview?.length ?? 0), 0),
            evidenceTruncated: false
        };
        const stats = {
            ...fallbackStats,
            ...(meta.stats as any)
        } as DocumentSearchResponse["stats"];

        return {
            query: pack.query,
            results,
            evidence,
            degraded: meta.degraded ?? false,
            reason: meta.reason,
            reasons: meta.reasons,
            provider: meta.provider ?? null,
            stats
        };
    }

    private toStoredItems(
        results: DocumentSearchSection[],
        evidence: DocumentSearchSection[] | undefined,
        includeEvidence: boolean,
        chunks: StoredDocumentChunk[],
        bm25ScoreMap: Map<string, number>,
        vectorScores: Map<string, number>,
        vectorEnabled: boolean
    ) {
        const byId = new Map(chunks.map(c => [c.id, c]));
        const out: any[] = [];
        let rank = 0;
        for (const r of results) {
            rank += 1;
            const chunk = byId.get(r.id);
            out.push({
                role: "result",
                rank,
                chunkId: r.id,
                filePath: r.filePath,
                kind: r.kind,
                sectionPath: r.sectionPath,
                heading: r.heading,
                headingLevel: r.headingLevel,
                range: r.range,
                preview: r.preview ?? "",
                scores: {
                    bm25: bm25ScoreMap.get(r.id) ?? 0,
                    vector: vectorEnabled ? vectorScores.get(r.id) : undefined,
                    final: r.scores?.final ?? 0
                },
                snapshot: { contentHash: chunk?.contentHash, updatedAt: chunk?.updatedAt }
            });
        }
        if (includeEvidence && Array.isArray(evidence)) {
            let eRank = 0;
            for (const e of evidence) {
                eRank += 1;
                const chunk = byId.get(e.id);
                out.push({
                    role: "evidence",
                    rank: eRank,
                    chunkId: e.id,
                    filePath: e.filePath,
                    kind: e.kind,
                    sectionPath: e.sectionPath,
                    heading: e.heading,
                    headingLevel: e.headingLevel,
                    range: e.range,
                    preview: e.preview ?? "",
                    scores: {
                        bm25: bm25ScoreMap.get(e.id) ?? 0,
                        vector: vectorEnabled ? vectorScores.get(e.id) : undefined,
                        final: e.scores?.final ?? 0
                    },
                    snapshot: { contentHash: chunk?.contentHash, updatedAt: chunk?.updatedAt }
                });
            }
        }
        return out;
    }

    private fillPreviewsFromSummaries(
        sections: DocumentSearchSection[],
        chunkById: Map<string, StoredDocumentChunk>,
        query: string,
        maxChars: number
    ): void {
        for (const section of sections) {
            const chunk = chunkById.get(section.id);
            if (!chunk) continue;
            const cached = this.evidencePacks?.getSummary(section.id, "preview", chunk.contentHash);
            if (cached) {
                section.preview = cached.length > maxChars ? `${cached.slice(0, Math.max(1, maxChars - 1))}…` : cached;
                continue;
            }
            const built = buildDeterministicPreview({
                text: chunk.text,
                query,
                kind: chunk.kind,
                maxChars
            });
            section.preview = built.preview;
            try {
                this.evidencePacks?.upsertSummary(section.id, "preview", built.preview, chunk.contentHash);
            } catch {
                // best-effort
            }
        }
    }

    private async isPackStale(items: Array<{ chunkId: string; snapshot?: { contentHash?: string } }>): Promise<boolean> {
        const pairs = items
            .map(item => ({ id: item.chunkId, hash: item.snapshot?.contentHash }))
            .filter(p => Boolean(p.id) && Boolean(p.hash)) as Array<{ id: string; hash: string }>;
        if (pairs.length === 0) return false;
        // Fast path: if the chunk still has the same content_hash, pack is fresh.
        for (const { id, hash } of pairs) {
            try {
                const current = this.chunkRepository.getContentHashByChunkId(id);
                if (current && current !== hash) return true;
            } catch {
                // ignore
            }
        }
        return false;
    }

    private async collectCandidateFiles(
        query: string,
        maxCandidates: number,
        includeComments: boolean,
        scope: "docs" | "project" | "all",
        includeLogs: boolean,
        includeMetrics: boolean
    ): Promise<string[]> {
        const includeGlobs = buildDocScopeGlobs(scope, includeComments, includeLogs, includeMetrics);

        const scoutResults = await this.searchEngine.scout({
            query,
            includeGlobs,
            maxResults: maxCandidates,
            groupByFile: true,
            deduplicateByContent: true
        });

        const paths = scoutResults
            .map(result => result.filePath)
            .filter(Boolean)
            .filter((filePath) => matchesDocScope(filePath, scope, includeComments, includeLogs, includeMetrics));
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const candidate of paths) {
            if (!candidate || seen.has(candidate)) continue;
            seen.add(candidate);
            unique.push(candidate);
        }
        if (unique.length < maxCandidates) {
            const extras = this.chunkRepository.listDocumentFiles(maxCandidates * 2);
            for (const extra of extras) {
                if (seen.has(extra)) continue;
                if (!matchesDocScope(extra, scope, includeComments, includeLogs, includeMetrics)) continue;
                seen.add(extra);
                unique.push(extra);
                if (unique.length >= maxCandidates) break;
            }
        }
        if (unique.length > 0) return unique;

        const filenameFallback = await this.searchEngine.searchFilenames(query, { maxResults: maxCandidates });
        return Array.from(
            new Set(
                filenameFallback
                    .map(result => result.path)
                    .filter((filePath) => matchesDocScope(filePath, scope, includeComments, includeLogs, includeMetrics))
            )
        );
    }

    private async collectChunks(filePaths: string[], includeComments: boolean): Promise<StoredDocumentChunk[]> {
        const chunks: StoredDocumentChunk[] = [];
        for (const filePath of filePaths) {
            let stored = this.chunkRepository.listChunksForFile(filePath);
            if (stored.length === 0) {
                try {
                    if (includeComments && this.symbolIndex && isCodeFile(filePath)) {
                        const abs = path.resolve(this.rootPath, filePath);
                        await this.symbolIndex.getSymbolsForFile(abs);
                    } else {
                        await this.documentIndexer.indexFile(filePath);
                    }
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
    ): Promise<{ scores: Map<string, number>; degraded: boolean; reasons: string[] }> {
        const reasons: string[] = [];
        let queryVector: Float32Array | undefined;
        const stopQueryEmbed = metrics.startTimer("docs.search.embedding_query_ms");
        try {
            [queryVector] = await provider.embed([query]);
        } catch (err: any) {
            if (err instanceof EmbeddingTimeoutError) {
                return { scores: new Map(), degraded: true, reasons: ["embedding_timeout"] };
            }
            return { scores: new Map(), degraded: true, reasons: ["vector_disabled"] };
        } finally {
            stopQueryEmbed();
        }
        if (!queryVector) {
            return { scores: new Map(), degraded: true, reasons: ["vector_disabled"] };
        }
        const scores = new Map<string, number>();
        const missing: StoredDocumentChunk[] = [];

        const stopVectorScore = metrics.startTimer("docs.search.vector_scoring_ms");
        try {
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
        } finally {
            stopVectorScore();
        }

        if (missing.length === 0) {
            return { scores, degraded: false, reasons: [] };
        }

        const startedAt = Date.now();
        let degraded = false;
        const limited = missing.slice(0, limits.maxChunks);
        if (missing.length > limits.maxChunks) {
            degraded = true;
            reasons.push("embedding_partial");
        }

        const batchSize = Math.max(1, Math.min(limits.maxChunks, 16));
        for (let i = 0; i < limited.length; i += batchSize) {
            const elapsed = Date.now() - startedAt;
            if (elapsed > limits.maxTimeMs) {
                degraded = true;
                reasons.push("embedding_timeout");
                break;
            }
            const batch = limited.slice(i, i + batchSize);
            let vectors: Float32Array[];
            try {
                const stopBatchEmbed = metrics.startTimer("docs.search.embedding_chunks_ms");
                try {
                    vectors = await provider.embed(batch.map(chunk => chunk.text));
                } finally {
                    stopBatchEmbed();
                }
            } catch (err: any) {
                degraded = true;
                if (err instanceof EmbeddingTimeoutError) {
                    reasons.push("embedding_timeout");
                } else {
                    reasons.push("vector_disabled");
                }
                break;
            }
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

        return { scores, degraded, reasons: Array.from(new Set(reasons)) };
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

function isCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".py";
}

function buildDocScopeGlobs(
    scope: "docs" | "project" | "all",
    includeComments: boolean,
    includeLogs: boolean,
    includeMetrics: boolean
): string[] {
    let includeGlobs: string[];
    if (scope === "docs") {
        includeGlobs = [
            "docs/**/*.md",
            "docs/**/*.mdx",
            "docs/**/README",
            "docs/**/README.*",
            "**/README",
            "**/README.*"
        ];
    } else if (scope === "project") {
        includeGlobs = [
            "**/*.md",
            "**/*.mdx",
            "**/README",
            "**/README.*"
        ];
    } else {
        includeGlobs = [
            "**/*.md",
            "**/*.mdx",
            "**/*.txt",
            "**/*.log",
            "**/*.docx",
            "**/*.xlsx",
            "**/*.pdf",
            "**/*.html",
            "**/*.htm",
            "**/*.css",
            "**/README",
            "**/LICENSE",
            "**/NOTICE",
            "**/CHANGELOG",
            "**/CODEOWNERS",
            "**/.gitignore",
            "**/.mcpignore",
            "**/.editorconfig"
        ];
    }

    if (includeLogs && scope !== "all") {
        includeGlobs.push("**/*.log", "**/*.txt");
    }
    if (includeMetrics) {
        includeGlobs.push(
            "**/*.csv",
            "**/*.json",
            "**/*.ndjson",
            "**/metrics/**/*.csv",
            "**/metrics/**/*.json",
            "**/metrics/**/*.ndjson",
            "**/monitoring/**/*.csv",
            "**/monitoring/**/*.json",
            "**/monitoring/**/*.ndjson",
            "**/*metrics*.csv",
            "**/*metrics*.json",
            "**/*metrics*.ndjson"
        );
    }
    if (includeComments) {
        includeGlobs.push("**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.py");
    }

    return includeGlobs;
}

function matchesDocScope(
    filePath: string,
    scope: "docs" | "project" | "all",
    includeComments: boolean,
    includeLogs: boolean,
    includeMetrics: boolean
): boolean {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, "/");
    if (includeComments && isCodeFile(normalized)) return true;
    if (scope === "all") return true;
    if (isReadmePath(normalized)) return true;
    if (includeLogs && isLogPath(normalized)) return true;
    if (includeMetrics && isMetricsPath(normalized)) return true;
    if (!isMarkdownPath(normalized)) return false;
    if (scope === "docs") return isDocsPath(normalized);
    return true;
}

function isMarkdownPath(filePath: string): boolean {
    return /\.(md|mdx)$/i.test(filePath);
}

function isReadmePath(filePath: string): boolean {
    const base = filePath.split("/").pop() ?? "";
    return /^readme(\.|$)/i.test(base);
}

function isLogPath(filePath: string): boolean {
    return /\.log$/i.test(filePath) || /\/logs?\//i.test(filePath);
}

function isMetricsPath(filePath: string): boolean {
    if (/\.(csv|json|ndjson)$/i.test(filePath)) return true;
    const base = filePath.split("/").pop() ?? "";
    return /metrics?/i.test(base);
}

function isDocsPath(filePath: string): boolean {
    return filePath.startsWith("docs/") || filePath.includes("/docs/");
}

function computePackId(query: string, options: unknown): string {
    const normalized = stableStringify({ query: String(query ?? ""), options });
    return crypto.createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: any): string {
    if (value === null || value === undefined) return String(value);
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(v => stableStringify(v)).join(",")}]`;
    }
    if (typeof value === "object") {
        const keys = Object.keys(value).sort();
        const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
        return `{${parts.join(",")}}`;
    }
    return JSON.stringify(String(value));
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
