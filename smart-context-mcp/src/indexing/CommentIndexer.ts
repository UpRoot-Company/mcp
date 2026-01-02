import * as crypto from "crypto";
import * as path from "path";
import { DocumentChunkRepository, type StoredDocumentChunk } from "./DocumentChunkRepository.js";
import { IndexDatabase } from "./IndexDatabase.js";
import type { SymbolInfo } from "../types.js";

export class CommentIndexer {
    private readonly chunkRepo: DocumentChunkRepository;

    constructor(private readonly indexDb: IndexDatabase) {
        this.chunkRepo = new DocumentChunkRepository(indexDb);
    }

    public upsertCommentChunksForFile(filePath: string, symbols: SymbolInfo[], content?: string): void {
        if (!filePath) return;
        const chunks: StoredDocumentChunk[] = [];
        const now = Date.now();
        for (const symbol of symbols ?? []) {
            const doc = (symbol as any)?.doc;
            if (typeof doc !== "string") continue;
            const normalized = normalizeDoc(doc);
            if (!normalized) continue;

            const range = (symbol as any)?.range ?? null;
            const startLine = typeof range?.startLine === "number" ? range.startLine + 1 : 1;
            const endLine = typeof range?.endLine === "number" ? range.endLine + 1 : startLine;
            const startByte = typeof range?.startByte === "number" ? range.startByte : 0;
            const endByte = typeof range?.endByte === "number" ? range.endByte : startByte;

            const container = (symbol as any)?.container;
            const name = (symbol as any)?.name ?? "unknown";
            const sectionPath = container ? [String(container), String(name)] : [String(name)];
            const heading = container ? `${container}.${name}` : String(name);

            chunks.push({
                id: hash(`${filePath}\ncode_comment\n${sectionPath.join(" > ")}\n${hash(normalized)}`),
                filePath,
                kind: "code_comment",
                sectionPath,
                heading,
                headingLevel: null,
                range: {
                    startLine: Math.max(1, startLine),
                    endLine: Math.max(Math.max(1, startLine), endLine),
                    startByte: Math.max(0, startByte),
                    endByte: Math.max(Math.max(0, startByte), endByte)
                },
                text: normalized,
                contentHash: hash(normalized),
                updatedAt: now
            });
        }

        // Fallback: when symbol-based docs are unavailable (ex: tree-sitter disabled), index lightweight
        // doc-style comment blocks so doc_search(includeComments=true) still returns something useful.
        if (chunks.length === 0 && typeof content === "string" && content.trim()) {
            chunks.push(...extractFallbackCommentChunks(filePath, content, now));
        }

        // Overwrite all comment chunks for this file in one transaction.
        this.chunkRepo.upsertChunksForFile(filePath, chunks);
    }
}

function normalizeDoc(doc: string): string {
    const raw = String(doc ?? "");
    if (!raw.trim()) return "";
    const lines = raw.split(/\r?\n/).map(line => {
        let out = line.trimEnd();
        out = out.replace(/^\/\*\*?/, "");
        out = out.replace(/\*\/$/, "");
        out = out.replace(/^\s*\*\s?/, "");
        out = out.replace(/^\/\//, "");
        out = out.replace(/^#/, "");
        return out.trimEnd();
    });
    const joined = lines.join("\n").trim();
    return joined;
}

function hash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

type CommentBlock = { raw: string; startIndex: number; endIndex: number };

function extractFallbackCommentChunks(filePath: string, content: string, now: number): StoredDocumentChunk[] {
    const ext = path.extname(filePath).toLowerCase();
    const blocks = ext === ".py"
        ? extractPythonDocstrings(content)
        : extractJsDocBlocks(content);

    if (blocks.length === 0) return [];

    const lineIndex = buildLineIndex(content);
    const chunks: StoredDocumentChunk[] = [];
    let seq = 0;
    for (const block of blocks) {
        const normalized = normalizeDoc(block.raw);
        if (!normalized) continue;
        if (!passesNoiseFilter(normalized)) continue;

        const startLine = lineIndex.lineAt(block.startIndex);
        const endLine = Math.max(startLine, lineIndex.lineAt(block.endIndex));
        const heading = `Comment@L${startLine}`;
        const sectionPath = ["Comments", `L${startLine}`, String(++seq)];

        chunks.push({
            id: hash(`${filePath}\ncode_comment\n${sectionPath.join(" > ")}\n${hash(normalized)}`),
            filePath,
            kind: "code_comment",
            sectionPath,
            heading,
            headingLevel: null,
            range: {
                startLine,
                endLine,
                startByte: Math.max(0, block.startIndex),
                endByte: Math.max(Math.max(0, block.startIndex), block.endIndex)
            },
            text: normalized,
            contentHash: hash(normalized),
            updatedAt: now
        });
    }
    return chunks;
}

function passesNoiseFilter(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 24) return false;
    if (/^(?:[-*_#/\\s]+)$/.test(trimmed)) return false;
    if (/eslint-disable|ts-ignore|prettier-ignore|noqa/i.test(trimmed)) return false;
    const letters = trimmed.replace(/[^A-Za-z]/g, "");
    if (letters.length < 12) return false;
    return true;
}

function extractJsDocBlocks(content: string): CommentBlock[] {
    const blocks: CommentBlock[] = [];
    const src = String(content ?? "");
    const regexes = [
        /\/\*\*[\s\S]*?\*\//g, // JSDoc blocks
        /\/\*(?!\*)[\s\S]*?\*\//g // block comments (non-JSDoc)
    ];
    for (const re of regexes) {
        let match: RegExpExecArray | null;
        while ((match = re.exec(src)) !== null) {
            const raw = match[0] ?? "";
            if (!raw) continue;
            blocks.push({ raw, startIndex: match.index, endIndex: match.index + raw.length });
        }
    }
    // stable order
    blocks.sort((a, b) => a.startIndex - b.startIndex);
    return blocks;
}

function extractPythonDocstrings(content: string): CommentBlock[] {
    const blocks: CommentBlock[] = [];
    const src = String(content ?? "");
    const regex = /(^|\n)[ \t]*(\"\"\"[\s\S]*?\"\"\"|'''[\s\S]*?''')/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(src)) !== null) {
        const raw = match[2] ?? "";
        if (!raw) continue;
        const startIndex = match.index + (match[1] ? match[1].length : 0);
        blocks.push({ raw, startIndex, endIndex: startIndex + raw.length });
    }
    blocks.sort((a, b) => a.startIndex - b.startIndex);
    return blocks;
}

function buildLineIndex(content: string): { lineAt(index: number): number } {
    const starts: number[] = [0];
    for (let i = 0; i < content.length; i += 1) {
        if (content[i] === "\n") {
            starts.push(i + 1);
        }
    }
    function lineAt(index: number): number {
        const target = Math.max(0, Math.min(index, content.length));
        let lo = 0;
        let hi = starts.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] <= target) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return Math.max(1, hi + 1);
    }
    return { lineAt };
}
