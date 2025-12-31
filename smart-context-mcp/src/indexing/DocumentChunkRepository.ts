import Database from "better-sqlite3";
import { IndexDatabase } from "./IndexDatabase.js";

export interface StoredDocumentChunk {
    id: string;
    filePath: string;
    kind: "markdown" | "mdx";
    sectionPath: string[];
    heading: string | null;
    headingLevel: number | null;
    range: { startLine: number; endLine: number; startByte: number; endByte: number };
    text: string;
    contentHash: string;
    updatedAt: number;
}

export class DocumentChunkRepository {
    private readonly db: Database.Database;
    private readonly deleteChunksForFileStmt: Database.Statement;
    private readonly insertChunkStmt: Database.Statement;
    private readonly selectChunksForFileStmt: Database.Statement;

    constructor(private readonly indexDb: IndexDatabase) {
        this.db = indexDb.getHandle();
        this.deleteChunksForFileStmt = this.db.prepare(`DELETE FROM document_chunks WHERE file_id = ?`);
        this.insertChunkStmt = this.db.prepare(`
            INSERT INTO document_chunks (
                id,
                file_id,
                kind,
                section_path_json,
                heading,
                heading_level,
                start_line,
                end_line,
                start_byte,
                end_byte,
                text,
                content_hash,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.selectChunksForFileStmt = this.db.prepare(`
            SELECT
                c.id as id,
                f.path as path,
                c.kind as kind,
                c.section_path_json as section_path_json,
                c.heading as heading,
                c.heading_level as heading_level,
                c.start_line as start_line,
                c.end_line as end_line,
                c.start_byte as start_byte,
                c.end_byte as end_byte,
                c.text as text,
                c.content_hash as content_hash,
                c.updated_at as updated_at
            FROM document_chunks c
            JOIN files f ON f.id = c.file_id
            WHERE f.path = ?
            ORDER BY c.start_line ASC
        `);
    }

    public upsertChunksForFile(filePath: string, chunks: StoredDocumentChunk[]): void {
        if (!filePath) return;
        const now = Date.now();
        const normalized = this.indexDb.getOrCreateFile(filePath);
        const tx = this.db.transaction((fileId: number, nextChunks: StoredDocumentChunk[]) => {
            this.deleteChunksForFileStmt.run(fileId);
            for (const chunk of nextChunks) {
                const updatedAt = chunk.updatedAt || now;
                this.insertChunkStmt.run(
                    chunk.id,
                    fileId,
                    chunk.kind,
                    JSON.stringify(chunk.sectionPath ?? []),
                    chunk.heading ?? null,
                    chunk.headingLevel ?? null,
                    chunk.range.startLine,
                    chunk.range.endLine,
                    chunk.range.startByte,
                    chunk.range.endByte,
                    chunk.text,
                    chunk.contentHash,
                    updatedAt
                );
            }
        });
        tx(normalized.id, chunks);
    }

    public deleteChunksForFile(filePath: string): void {
        const file = this.indexDb.getFile(filePath);
        if (!file) return;
        this.deleteChunksForFileStmt.run(file.id);
    }

    public listChunksForFile(filePath: string): StoredDocumentChunk[] {
        const file = this.indexDb.getFile(filePath);
        if (!file) return [];
        const rows = this.selectChunksForFileStmt.all(file.path) as Array<{
            id: string;
            path: string;
            kind: "markdown" | "mdx";
            section_path_json: string;
            heading: string | null;
            heading_level: number | null;
            start_line: number;
            end_line: number;
            start_byte: number;
            end_byte: number;
            text: string;
            content_hash: string;
            updated_at: number;
        }>;
        return rows.map(row => ({
            id: row.id,
            filePath: row.path,
            kind: row.kind,
            sectionPath: safeParseJson(row.section_path_json, []),
            heading: row.heading ?? null,
            headingLevel: row.heading_level ?? null,
            range: {
                startLine: row.start_line,
                endLine: row.end_line,
                startByte: row.start_byte,
                endByte: row.end_byte
            },
            text: row.text,
            contentHash: row.content_hash,
            updatedAt: row.updated_at
        }));
    }
}

function safeParseJson<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}
