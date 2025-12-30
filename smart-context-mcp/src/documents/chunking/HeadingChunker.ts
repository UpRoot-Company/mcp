import * as crypto from "crypto";
import * as path from "path";
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
        const effectiveOutline = outline.length === 0
            ? [{
                filePath,
                kind,
                title: path.basename(filePath),
                level: 1,
                path: [path.basename(filePath)],
                range: { startLine: 1, endLine: lines.length, startByte: 0, endByte: normalizedContent.length }
            }]
            : outline;

        for (let index = 0; index < effectiveOutline.length; index += 1) {
            const section = effectiveOutline[index];
            const range = {
                startLine: section.range.startLine,
                endLine: section.range.endLine
            };

            if (strategy === "heading") {
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

            const segments = strategy === "fixed"
                ? splitFixedSegments(lines, range.startLine, range.endLine, options)
                : normalizeSegments(
                    splitStructuralSegments(lines, range.startLine, range.endLine, options),
                    options
                );

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

function splitFixedSegments(
    lines: string[],
    startLine: number,
    endLine: number,
    options: DocumentOutlineOptions
): Array<{ startLine: number; endLine: number; text: string }> {
    const target = options.targetChunkChars ?? 1200;
    const maxBlock = options.maxBlockChars ?? target;
    let segments = splitRangeByMaxChars(lines, startLine, endLine, maxBlock);
    if (target && target > 0) {
        segments = packSegments(segments, target, options.minSectionChars, maxBlock);
    }
    if (options.minSectionChars) {
        segments = mergeSmallSegments(segments, options.minSectionChars, maxBlock);
    }
    return segments;
}

function normalizeSegments(
    segments: Array<{ startLine: number; endLine: number; text: string }>,
    options: DocumentOutlineOptions
): Array<{ startLine: number; endLine: number; text: string }> {
    const maxBlock = options.maxBlockChars ?? options.targetChunkChars;
    let normalized = maxBlock ? splitSegmentsByMaxChars(segments, maxBlock) : segments;
    if (options.targetChunkChars) {
        normalized = packSegments(normalized, options.targetChunkChars, options.minSectionChars, maxBlock);
    }
    if (options.minSectionChars) {
        normalized = mergeSmallSegments(normalized, options.minSectionChars, maxBlock);
    }
    return normalized;
}

function splitSegmentsByMaxChars(
    segments: Array<{ startLine: number; endLine: number; text: string }>,
    maxChars: number
): Array<{ startLine: number; endLine: number; text: string }> {
    if (!maxChars || maxChars <= 0) return segments;
    const expanded: Array<{ startLine: number; endLine: number; text: string }> = [];
    for (const segment of segments) {
        if (segment.text.length <= maxChars) {
            expanded.push(segment);
            continue;
        }
        const lines = segment.text.split(/\r?\n/);
        let currentStart = segment.startLine;
        let buffer: string[] = [];
        let bufferLength = 0;
        for (let offset = 0; offset < lines.length; offset += 1) {
            const line = lines[offset] ?? "";
            const nextLength = bufferLength === 0 ? line.length : bufferLength + 1 + line.length;
            if (bufferLength > 0 && nextLength > maxChars) {
                const endLine = currentStart + buffer.length - 1;
                expanded.push({
                    startLine: currentStart,
                    endLine,
                    text: buffer.join("\n")
                });
                currentStart = endLine + 1;
                buffer = [line];
                bufferLength = line.length;
                continue;
            }
            buffer.push(line);
            bufferLength = nextLength;
        }
        if (buffer.length > 0) {
            expanded.push({
                startLine: currentStart,
                endLine: currentStart + buffer.length - 1,
                text: buffer.join("\n")
            });
        }
    }
    return expanded;
}

function splitRangeByMaxChars(
    lines: string[],
    startLine: number,
    endLine: number,
    maxChars: number
): Array<{ startLine: number; endLine: number; text: string }> {
    if (!maxChars || maxChars <= 0) {
        return [makeSegment(lines, startLine, endLine)];
    }
    const segments: Array<{ startLine: number; endLine: number; text: string }> = [];
    let buffer: string[] = [];
    let bufferLength = 0;
    let currentStart = startLine;

    for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
        const line = lines[lineIndex - 1] ?? "";
        const nextLength = bufferLength === 0 ? line.length : bufferLength + 1 + line.length;
        if (bufferLength > 0 && nextLength > maxChars) {
            segments.push({
                startLine: currentStart,
                endLine: currentStart + buffer.length - 1,
                text: buffer.join("\n")
            });
            currentStart = lineIndex;
            buffer = [line];
            bufferLength = line.length;
            continue;
        }
        buffer.push(line);
        bufferLength = nextLength;
    }

    if (buffer.length > 0) {
        segments.push({
            startLine: currentStart,
            endLine: currentStart + buffer.length - 1,
            text: buffer.join("\n")
        });
    }

    return segments;
}

function packSegments(
    segments: Array<{ startLine: number; endLine: number; text: string }>,
    targetChars: number,
    minSectionChars?: number,
    maxChars?: number
): Array<{ startLine: number; endLine: number; text: string }> {
    if (!targetChars || segments.length <= 1) return segments;
    const packed: Array<{ startLine: number; endLine: number; text: string }> = [];
    let current = segments[0];

    for (let i = 1; i < segments.length; i += 1) {
        const next = segments[i];
        const combinedText = `${current.text}\n${next.text}`;
        const combinedLength = combinedText.length;
        const forceMerge = minSectionChars ? current.text.length < minSectionChars : false;
        const withinTarget = combinedLength <= targetChars;
        const withinMax = !maxChars || combinedLength <= maxChars;
        if ((withinTarget || forceMerge) && withinMax) {
            current = {
                startLine: current.startLine,
                endLine: next.endLine,
                text: combinedText
            };
        } else {
            packed.push(current);
            current = next;
        }
    }
    packed.push(current);
    return packed;
}

function mergeSmallSegments(
    segments: Array<{ startLine: number; endLine: number; text: string }>,
    minChars: number,
    maxChars?: number
): Array<{ startLine: number; endLine: number; text: string }> {
    if (!minChars || segments.length <= 1) return segments;
    const merged: Array<{ startLine: number; endLine: number; text: string }> = [];
    let i = 0;
    while (i < segments.length) {
        const segment = segments[i];
        if (segment.text.length >= minChars) {
            merged.push(segment);
            i += 1;
            continue;
        }
        const next = segments[i + 1];
        if (next) {
            const combinedText = `${segment.text}\n${next.text}`;
            if (!maxChars || combinedText.length <= maxChars) {
                segments[i + 1] = {
                    startLine: segment.startLine,
                    endLine: next.endLine,
                    text: combinedText
                };
                i += 1;
                continue;
            }
        }
        if (merged.length > 0) {
            const prev = merged.pop()!;
            const combinedText = `${prev.text}\n${segment.text}`;
            merged.push({
                startLine: prev.startLine,
                endLine: segment.endLine,
                text: combinedText
            });
        } else {
            merged.push(segment);
        }
        i += 1;
    }
    return merged;
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
