import * as crypto from "crypto";
import { DocumentKind, DocumentOutlineOptions, DocumentSection } from "../../types.js";
import { StoredDocumentChunk } from "../../indexing/DocumentChunkRepository.js";
import { applyMdxPlaceholders } from "../DocumentProfiler.js";

export class HeadingChunker {
    public chunk(
        filePath: string,
        kind: DocumentKind,
        outline: DocumentSection[],
        content: string,
        options: DocumentOutlineOptions = {}
    ): StoredDocumentChunk[] {
        const normalizedContent = kind === "mdx" ? applyMdxPlaceholders(content) : content;
        const lines = normalizedContent.split(/\r?\n/);
        const lineOffsets = computeLineOffsets(normalizedContent);
        const strategy = options.chunkStrategy ?? "structural";
        const chunks: StoredDocumentChunk[] = [];

        if (outline.length === 0) {
            chunks.push(this.buildChunk({
                filePath,
                kind,
                sectionPath: [filePath],
                heading: null,
                headingLevel: null,
                startLine: 1,
                endLine: lines.length,
                lines,
                lineOffsets,
                ordinal: 0
            }));
            return chunks;
        }

        for (let index = 0; index < outline.length; index += 1) {
            const section = outline[index];
            const range = {
                startLine: section.range.startLine,
                endLine: section.range.endLine
            };

            if (strategy !== "structural") {
                chunks.push(this.buildChunk({
                    filePath,
                    kind,
                    sectionPath: section.path,
                    heading: section.title,
                    headingLevel: section.level,
                    startLine: range.startLine,
                    endLine: range.endLine,
                    lines,
                    lineOffsets,
                    ordinal: 0
                }));
                continue;
            }

            const segments = splitStructuralSegments(lines, range.startLine, range.endLine, options);
            let ordinal = 0;
            for (const segment of segments) {
                if (!segment.text.trim()) continue;
                chunks.push(this.buildChunk({
                    filePath,
                    kind,
                    sectionPath: section.path,
                    heading: section.title,
                    headingLevel: section.level,
                    startLine: segment.startLine,
                    endLine: segment.endLine,
                    lines,
                    lineOffsets,
                    ordinal
                }));
                ordinal += 1;
            }
        }

        return chunks;
    }

    private buildChunk(args: {
        filePath: string;
        kind: DocumentKind;
        sectionPath: string[];
        heading: string | null;
        headingLevel: number | null;
        startLine: number;
        endLine: number;
        lines: string[];
        lineOffsets: number[];
        ordinal: number;
    }): StoredDocumentChunk {
        const text = args.lines.slice(args.startLine - 1, args.endLine).join("\n");
        return {
            id: hash(`${args.filePath}\n${args.sectionPath.join(" > ")}\n${args.startLine}:${args.endLine}\n${args.ordinal}`),
            filePath: args.filePath,
            kind: args.kind === "mdx" ? "mdx" : "markdown",
            sectionPath: args.sectionPath,
            heading: args.heading,
            headingLevel: args.headingLevel,
            range: {
                startLine: args.startLine,
                endLine: args.endLine,
                startByte: args.lineOffsets[args.startLine - 1] ?? 0,
                endByte: computeEndByte(args.endLine, args.lines, args.lineOffsets)
            },
            text,
            contentHash: hash(text),
            updatedAt: Date.now()
        };
    }
}

function splitStructuralSegments(
    lines: string[],
    startLine: number,
    endLine: number,
    options: DocumentOutlineOptions
): Array<{ startLine: number; endLine: number; text: string }> {
    const segments: Array<{ startLine: number; endLine: number; text: string }> = [];
    let cursor = startLine;
    let lineIndex = startLine;
    let inCodeBlock = false;

    while (lineIndex <= endLine) {
        const line = lines[lineIndex - 1] ?? "";
        if (isFence(line)) {
            if (!inCodeBlock) {
                if (lineIndex > cursor) {
                    segments.push(makeSegment(lines, cursor, lineIndex - 1));
                }
                inCodeBlock = true;
                const endFence = findFenceEnd(lines, lineIndex + 1, endLine);
                const blockEnd = endFence ?? endLine;
                if (options.includeCodeBlocks !== false) {
                    segments.push(makeSegment(lines, lineIndex, blockEnd));
                }
                lineIndex = blockEnd + 1;
                cursor = lineIndex;
                inCodeBlock = false;
                continue;
            }
        }

        if (!inCodeBlock && options.includeTables !== false && isTableLine(line)) {
            if (lineIndex > cursor) {
                segments.push(makeSegment(lines, cursor, lineIndex - 1));
            }
            const tableEnd = consumeWhile(lines, lineIndex, endLine, isTableLine);
            segments.push(makeSegment(lines, lineIndex, tableEnd));
            lineIndex = tableEnd + 1;
            cursor = lineIndex;
            continue;
        }

        if (!inCodeBlock && options.includeLists !== false && isListLine(line)) {
            if (lineIndex > cursor) {
                segments.push(makeSegment(lines, cursor, lineIndex - 1));
            }
            const listEnd = consumeWhile(lines, lineIndex, endLine, isListLine);
            segments.push(makeSegment(lines, lineIndex, listEnd));
            lineIndex = listEnd + 1;
            cursor = lineIndex;
            continue;
        }

        lineIndex += 1;
    }

    if (cursor <= endLine) {
        segments.push(makeSegment(lines, cursor, endLine));
    }

    return segments.filter(segment => segment.startLine <= segment.endLine);
}

function consumeWhile(
    lines: string[],
    startLine: number,
    endLine: number,
    predicate: (line: string) => boolean
): number {
    let idx = startLine;
    while (idx <= endLine) {
        const line = lines[idx - 1] ?? "";
        if (!predicate(line)) {
            return idx - 1;
        }
        idx += 1;
    }
    return endLine;
}

function makeSegment(lines: string[], startLine: number, endLine: number) {
    return {
        startLine,
        endLine,
        text: lines.slice(startLine - 1, endLine).join("\n")
    };
}

function isFence(line: string): boolean {
    return /^```|^~~~/.test(line.trim());
}

function findFenceEnd(lines: string[], startLine: number, endLine: number): number | null {
    for (let idx = startLine; idx <= endLine; idx += 1) {
        if (isFence(lines[idx - 1] ?? "")) return idx;
    }
    return null;
}

function isTableLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (!trimmed.includes("|")) return false;
    return true;
}

function isListLine(line: string): boolean {
    return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

function computeLineOffsets(content: string): number[] {
    const offsets: number[] = [];
    let offset = 0;
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        offsets.push(offset);
        offset += line.length + 1;
    }
    return offsets;
}

function computeEndByte(endLine: number, lines: string[], offsets: number[]): number {
    const index = Math.max(0, Math.min(endLine - 1, lines.length - 1));
    const lineOffset = offsets[index] ?? 0;
    return lineOffset + lines[index].length;
}

function hash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}
