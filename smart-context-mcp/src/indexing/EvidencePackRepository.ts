import Database from "better-sqlite3";
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
    private readonly db: Database.Database;

    private readonly upsertPackStmt: Database.Statement;
    private readonly deletePackStmt: Database.Statement;
    private readonly insertItemStmt: Database.Statement;
    private readonly selectPackStmt: Database.Statement;
    private readonly selectItemsStmt: Database.Statement;
    private readonly upsertSummaryStmt: Database.Statement;
    private readonly selectSummaryStmt: Database.Statement;

    constructor(private readonly indexDb: IndexDatabase) {
        this.db = indexDb.getHandle();

        this.upsertPackStmt = this.db.prepare(`
            INSERT INTO evidence_packs (pack_id, query, options_json, created_at, expires_at, meta_json, root_fingerprint)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(pack_id) DO UPDATE SET
                query = excluded.query,
                options_json = excluded.options_json,
                created_at = excluded.created_at,
                expires_at = excluded.expires_at,
                meta_json = excluded.meta_json,
                root_fingerprint = excluded.root_fingerprint
        `);
        this.deletePackStmt = this.db.prepare(`DELETE FROM evidence_packs WHERE pack_id = ?`);
        this.insertItemStmt = this.db.prepare(`
            INSERT INTO evidence_pack_items (
                pack_id,
                role,
                rank,
                chunk_id,
                file_path,
                kind,
                section_path_json,
                heading,
                heading_level,
                start_line,
                end_line,
                preview,
                content_hash_snapshot,
                updated_at_snapshot,
                scores_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.selectPackStmt = this.db.prepare(`
            SELECT pack_id, query, options_json, created_at, expires_at, meta_json, root_fingerprint
            FROM evidence_packs
            WHERE pack_id = ?
        `);
        this.selectItemsStmt = this.db.prepare(`
            SELECT
                role,
                rank,
                chunk_id,
                file_path,
                kind,
                section_path_json,
                heading,
                heading_level,
                start_line,
                end_line,
                preview,
                content_hash_snapshot,
                updated_at_snapshot,
                scores_json
            FROM evidence_pack_items
            WHERE pack_id = ?
            ORDER BY role ASC, rank ASC
        `);

        this.upsertSummaryStmt = this.db.prepare(`
            INSERT INTO chunk_summaries (chunk_id, style, summary, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(chunk_id, style) DO UPDATE SET
                summary = excluded.summary,
                created_at = excluded.created_at
        `);
        this.selectSummaryStmt = this.db.prepare(`
            SELECT summary
            FROM chunk_summaries
            WHERE chunk_id = ? AND style = ?
        `);
    }

    public upsertPack(pack: StoredEvidencePack): void {
        const now = Date.now();
        const createdAt = Number.isFinite(pack.createdAt) && pack.createdAt > 0 ? pack.createdAt : now;
        const expiresAt = pack.expiresAt && pack.expiresAt > createdAt ? pack.expiresAt : null;
        const optionsJson = JSON.stringify(pack.options ?? {});
        const metaJson = pack.meta ? JSON.stringify(pack.meta) : null;

        const tx = this.db.transaction((p: StoredEvidencePack) => {
            this.upsertPackStmt.run(
                p.packId,
                p.query,
                optionsJson,
                createdAt,
                expiresAt,
                metaJson,
                p.rootFingerprint
            );
            this.db.prepare(`DELETE FROM evidence_pack_items WHERE pack_id = ?`).run(p.packId);
            for (const item of p.items ?? []) {
                this.insertItemStmt.run(
                    p.packId,
                    item.role,
                    item.rank,
                    item.chunkId,
                    item.filePath,
                    item.kind,
                    JSON.stringify(item.sectionPath ?? []),
                    item.heading ?? null,
                    item.headingLevel ?? null,
                    item.range?.startLine ?? null,
                    item.range?.endLine ?? null,
                    item.preview ?? "",
                    item.snapshot?.contentHash ?? null,
                    item.snapshot?.updatedAt ?? null,
                    item.scores ? JSON.stringify(item.scores) : null
                );
            }
        });
        tx(pack);
    }

    public getPack(packId: string): StoredEvidencePack | null {
        if (!packId) return null;
        const row = this.selectPackStmt.get(packId) as
            | {
                pack_id: string;
                query: string;
                options_json: string;
                created_at: number;
                expires_at: number | null;
                meta_json: string | null;
                root_fingerprint: string;
            }
            | undefined;
        if (!row) return null;

        const now = Date.now();
        const expiresAt = row.expires_at ?? undefined;
        if (expiresAt && expiresAt <= now) {
            // best-effort cleanup
            try { this.deletePackStmt.run(packId); } catch {}
            return null;
        }

        const itemRows = this.selectItemsStmt.all(packId) as Array<{
            role: EvidencePackRole;
            rank: number;
            chunk_id: string;
            file_path: string;
            kind: DocumentKind;
            section_path_json: string | null;
            heading: string | null;
            heading_level: number | null;
            start_line: number | null;
            end_line: number | null;
            preview: string;
            content_hash_snapshot: string | null;
            updated_at_snapshot: number | null;
            scores_json: string | null;
        }>;

        const items: StoredEvidenceItem[] = itemRows.map(r => ({
            role: r.role,
            rank: r.rank,
            chunkId: r.chunk_id,
            filePath: r.file_path,
            kind: r.kind,
            sectionPath: safeParseJson(r.section_path_json ?? "[]", []),
            heading: r.heading ?? null,
            headingLevel: r.heading_level ?? null,
            range: { startLine: r.start_line ?? 1, endLine: r.end_line ?? (r.start_line ?? 1) },
            preview: r.preview ?? "",
            scores: r.scores_json ? safeParseJson(r.scores_json, undefined) : undefined,
            snapshot: {
                contentHash: r.content_hash_snapshot ?? undefined,
                updatedAt: r.updated_at_snapshot ?? undefined
            }
        }));

        const options = safeParseJson(row.options_json, {});
        const meta = row.meta_json ? safeParseJson(row.meta_json, undefined) : undefined;

        return {
            packId: row.pack_id,
            query: row.query,
            createdAt: row.created_at,
            expiresAt,
            rootFingerprint: row.root_fingerprint,
            options,
            meta,
            items
        };
    }

    public getSummary(chunkId: string, style: "preview" | "summary" = "preview"): string | null {
        if (!chunkId) return null;
        const row = this.selectSummaryStmt.get(chunkId, style) as { summary?: string } | undefined;
        const value = row?.summary;
        return typeof value === "string" && value.trim().length > 0 ? value : null;
    }

    public upsertSummary(chunkId: string, style: "preview" | "summary", summary: string): void {
        if (!chunkId) return;
        const normalized = String(summary ?? "").trim();
        if (!normalized) return;
        this.upsertSummaryStmt.run(chunkId, style, normalized, Date.now());
    }
}

export function computeRootFingerprint(rootPath: string): string {
    const normalized = String(rootPath ?? "").replace(/\\/g, "/");
    return crypto.createHash("sha256").update(normalized).digest("hex");
}

function safeParseJson<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}
