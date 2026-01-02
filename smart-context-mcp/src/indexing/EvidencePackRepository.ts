import * as crypto from "crypto";
import { IndexDatabase } from "./IndexDatabase.js";
import type { DocumentKind, EmbeddingConfig } from "../types.js";

export type EvidencePackRole = "result" | "evidence";

export type StoredEvidenceItem = {
    role: EvidencePackRole;
    rank: number;
    chunkId: string;
    filePath: string;
    kind: DocumentKind;
    sectionPath: string[];
    heading: string | null;
    headingLevel: number | null;
    range: { startLine: number; endLine: number };
    preview: string;
    scores?: { bm25: number; vector?: number; final: number };
    snapshot?: { contentHash?: string; updatedAt?: number };
};

export type StoredEvidencePack = {
    packId: string;
    query: string;
    createdAt: number;
    expiresAt?: number;
    rootFingerprint: string;
    options: {
        output?: "full" | "compact" | "pack_only";
        includeEvidence?: boolean;
        includeComments?: boolean;
        snippetLength?: number;
        maxResults?: number;
        maxCandidates?: number;
        maxChunkCandidates?: number;
        maxVectorCandidates?: number;
        maxEvidenceSections?: number;
        maxEvidenceChars?: number;
        rrfK?: number;
        rrfDepth?: number;
        useMmr?: boolean;
        mmrLambda?: number;
        maxChunksEmbeddedPerRequest?: number;
        maxEmbeddingTimeMs?: number;
        embedding?: EmbeddingConfig | null;
    };
    meta?: {
        degraded?: boolean;
        reason?: string;
        reasons?: string[];
        provider?: { name: string; model: string; dims: number } | null;
        stats?: Record<string, unknown>;
    };
    items: StoredEvidenceItem[];
};

export class EvidencePackRepository {
    constructor(private readonly indexDb: IndexDatabase) {
    }

    public upsertPack(pack: StoredEvidencePack): void {
        const now = Date.now();
        const createdAt = Number.isFinite(pack.createdAt) && pack.createdAt > 0 ? pack.createdAt : now;
        const expiresAt = pack.expiresAt && pack.expiresAt > createdAt ? pack.expiresAt : null;
        const payload: StoredEvidencePack = {
            ...pack,
            createdAt,
            expiresAt: expiresAt ?? undefined
        };
        this.indexDb.upsertEvidencePack(pack.packId, payload);
    }

    public getPack(packId: string): StoredEvidencePack | null {
        if (!packId) return null;
        const stored = this.indexDb.getEvidencePack(packId) as StoredEvidencePack | null;
        if (!stored) return null;
        const now = Date.now();
        if (stored.expiresAt && stored.expiresAt <= now) {
            this.indexDb.deleteEvidencePack(packId);
            return null;
        }
        return stored;
    }

    public getSummary(chunkId: string, style: "preview" | "summary" = "preview", contentHash?: string): string | null {
        if (!chunkId) return null;
        const entry = this.indexDb.getChunkSummary(chunkId, style);
        if (!entry) return null;
        if (contentHash && entry.contentHash && entry.contentHash !== contentHash) {
            return null;
        }
        return typeof entry.summary === "string" && entry.summary.trim().length > 0 ? entry.summary : null;
    }

    public upsertSummary(chunkId: string, style: "preview" | "summary", summary: string, contentHash?: string): void {
        if (!chunkId) return;
        const normalized = String(summary ?? "").trim();
        if (!normalized) return;
        this.indexDb.upsertChunkSummary(chunkId, style, normalized, contentHash);
    }
}

export function computeRootFingerprint(rootPath: string): string {
    const normalized = String(rootPath ?? "").replace(/\\/g, "/");
    return crypto.createHash("sha256").update(normalized).digest("hex");
}

