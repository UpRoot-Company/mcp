import * as crypto from "crypto";
import * as path from "path";
import { DocumentKind, DocumentOutlineOptions, DocumentProfile, DocumentSection } from "../types.js";
import { DocumentLinkResolver } from "./DocumentLinkResolver.js";

export interface DocumentProfileInput {
    filePath: string;
    content: string;
    kind: DocumentKind;
    options?: DocumentOutlineOptions;
}

interface HeadingNode {
    title: string;
    level: number;
    line: number;
}

interface LinkNode {
    text: string;
    href: string;
    line: number;
}

export class DocumentProfiler {
    constructor(
        private readonly rootPath: string,
        private readonly linkResolver: DocumentLinkResolver = new DocumentLinkResolver(rootPath)
    ) {}

    public profile(input: DocumentProfileInput): DocumentProfile {
        const options = input.options ?? {};
        const lines = splitLines(input.content);
        const lineOffsets = computeLineOffsets(input.content);

        const frontmatter = options.includeFrontmatter === false
            ? undefined
            : parseFrontmatter(input.content);

        const headings = extractHeadings(lines);
        const outline = buildOutline({
            filePath: input.filePath,
            kind: input.kind,
            headings,
            lines,
            lineOffsets
        });

        const links = extractLinks(lines)
            .map(link => this.linkResolver.resolveLink(input.filePath, link.href, link.text));

        const title = resolveTitle(frontmatter, outline, input.filePath);
        return {
            filePath: input.filePath,
            kind: input.kind,
            title,
            frontmatter,
            outline,
            links,
            stats: {
                lineCount: lines.length,
                charCount: input.content.length,
                headingCount: headings.length
            }
        };
    }

    public buildSkeleton(profile: DocumentProfile): string {
        const outline = profile.outline;
        if (!outline || outline.length === 0) {
            const fallback = profile.title ?? path.basename(profile.filePath);
            return `# ${fallback}\n`;
        }
        const lines: string[] = [];
        for (const section of outline) {
            const indent = "  ".repeat(Math.max(0, section.level - 1));
            lines.push(`${indent}- ${section.title}`);
        }
        return lines.join("\n");
    }

    public static normalizeHeading(value: string): string {
        return value
            .toLowerCase()
            .replace(/\s+/g, " ")
            .replace(/[#:*_`~]+/g, "")
            .trim();
    }
}

function splitLines(content: string): string[] {
    return content.split(/\r?\n/);
}

function computeLineOffsets(content: string): number[] {
    const offsets: number[] = [];
    let offset = 0;
    const lines = splitLines(content);
    for (const line of lines) {
        offsets.push(offset);
        offset += line.length + 1; // assume single newline (CRLF already split)
    }
    return offsets;
}

function parseFrontmatter(content: string): Record<string, unknown> | undefined {
    if (!content.startsWith("---")) return undefined;
    const endIndex = content.indexOf("\n---", 3);
    if (endIndex === -1) return undefined;
    const raw = content.slice(3, endIndex).trim();
    if (!raw) return undefined;
    const result: Record<string, unknown> = {};
    for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*([\w\-]+)\s*:\s*(.+)\s*$/);
        if (!match) continue;
        const [, key, valueRaw] = match;
        result[key] = parseFrontmatterValue(valueRaw);
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function parseFrontmatterValue(value: string): unknown {
    const trimmed = value.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    const asNumber = Number(trimmed);
    if (!Number.isNaN(asNumber) && trimmed !== "") return asNumber;
    return trimmed.replace(/^['"]|['"]$/g, "");
}

function extractHeadings(lines: string[]): HeadingNode[] {
    const headings: HeadingNode[] = [];
    let inCodeBlock = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (isFence(line)) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;
        const match = line.match(/^(#{1,6})\s+(.*)$/);
        if (!match) continue;
        const level = match[1].length;
        let title = match[2].replace(/\s+#*$/, "").trim();
        title = stripInlineJsx(title);
        if (!title) continue;
        headings.push({ title, level, line: index + 1 });
    }
    return headings;
}

function extractLinks(lines: string[]): LinkNode[] {
    const links: LinkNode[] = [];
    let inCodeBlock = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (isFence(line)) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;
        const regex = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
            const text = match[1];
            const href = match[2];
            links.push({ text, href, line: index + 1 });
        }
    }
    return links;
}

function buildOutline(params: {
    filePath: string;
    kind: DocumentKind;
    headings: HeadingNode[];
    lines: string[];
    lineOffsets: number[];
}): DocumentSection[] {
    const { filePath, kind, headings, lines, lineOffsets } = params;
    if (headings.length === 0) {
        const title = path.basename(filePath);
        return [
            buildSection({
                filePath,
                kind,
                title,
                level: 1,
                path: [title],
                startLine: 1,
                endLine: lines.length,
                lineOffsets,
                lines,
                ordinal: 0
            })
        ];
    }

    const sections: DocumentSection[] = [];
    const stack: Array<{ title: string; level: number }> = [];
    const pathCounts = new Map<string, number>();

    for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index];
        while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
            stack.pop();
        }
        stack.push({ title: heading.title, level: heading.level });
        const pathTitles = stack.map(item => item.title);
        const pathKey = pathTitles.join(" > ");
        const ordinal = (pathCounts.get(pathKey) ?? 0) + 1;
        pathCounts.set(pathKey, ordinal);

        const nextHeading = headings[index + 1];
        const endLine = nextHeading ? nextHeading.line - 1 : lines.length;
        sections.push(
            buildSection({
                filePath,
                kind,
                title: heading.title,
                level: heading.level,
                path: [...pathTitles],
                startLine: heading.line,
                endLine: Math.max(heading.line, endLine),
                lineOffsets,
                lines,
                ordinal
            })
        );
    }

    return sections;
}

function buildSection(params: {
    filePath: string;
    kind: DocumentKind;
    title: string;
    level: number;
    path: string[];
    startLine: number;
    endLine: number;
    lines: string[];
    lineOffsets: number[];
    ordinal: number;
}): DocumentSection {
    const { filePath, kind, title, level, path, startLine, endLine, lines, lineOffsets, ordinal } = params;
    const text = lines.slice(startLine - 1, endLine).join("\n");
    const contentHash = hash(text);
    return {
        id: hash(`${filePath}\n${path.join(" > ")}\n${ordinal}`),
        filePath,
        kind,
        title,
        level,
        path,
        range: {
            startLine,
            endLine,
            startByte: lineOffsets[startLine - 1] ?? 0,
            endByte: computeEndByte(endLine, lines, lineOffsets)
        },
        contentHash
    };
}

function computeEndByte(endLine: number, lines: string[], offsets: number[]): number {
    const index = Math.max(0, Math.min(endLine - 1, lines.length - 1));
    const lineOffset = offsets[index] ?? 0;
    return lineOffset + lines[index].length;
}

function hash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function resolveTitle(frontmatter: Record<string, unknown> | undefined, outline: DocumentSection[], filePath: string): string {
    const fmTitle = frontmatter?.title;
    if (typeof fmTitle === "string" && fmTitle.trim()) {
        return fmTitle.trim();
    }
    const h1 = outline.find(section => section.level === 1);
    if (h1?.title) return h1.title;
    return path.basename(filePath);
}

function stripInlineJsx(value: string): string {
    return value.replace(/<[^>]+>/g, "").trim();
}

function isFence(line: string): boolean {
    return /^```|^~~~/.test(line.trim());
}

export function applyMdxPlaceholders(content: string): string {
    let output = content;
    output = output.replace(/\{([A-Za-z0-9_$]+)\}/g, (_, name) => `[[mdx:${name}]]`);
    output = output.replace(/\{[^}]+\}/g, "[[mdx:expr]]");
    output = output.replace(/<([A-Za-z0-9_]+)([^>]*)\/>/g, (_, name, attrs) => {
        const summarized = summarizeMdxProps(String(attrs));
        return `[[mdx:${name}${summarized ? " " + summarized : ""}]]`;
    });
    output = output.replace(/<([A-Za-z0-9_]+)([^>]*)>([\s\S]*?)<\/\1>/g, (_, name, attrs, children) => {
        const summarized = summarizeMdxProps(String(attrs));
        const childText = stripInlineJsx(String(children)).trim();
        if (childText) {
            return `${childText}`;
        }
        return `[[mdx:${name}${summarized ? " " + summarized : ""}]]`;
    });
    return output;
}

function summarizeMdxProps(raw: string): string {
    const props: string[] = [];
    const attrRegex = /([A-Za-z0-9_]+)\s*=\s*("([^"]*)"|'([^']*)'|\{([^}]+)\}|([^\s>]+))/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(raw)) !== null) {
        const name = match[1];
        const rawValue = match[3] ?? match[4] ?? match[5] ?? match[6];
        if (rawValue == null) continue;
        const normalized = normalizePropValue(rawValue);
        if (normalized == null) continue;
        props.push(`${name}="${normalized}"`);
    }
    return props.join(" ");
}

function normalizePropValue(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed === "true" || trimmed === "false") return trimmed;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
    if (/^[A-Za-z0-9_\-./ ]+$/.test(trimmed)) return trimmed;
    return null;
}
