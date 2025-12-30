import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { WebTreeSitterBackend } from "../ast/WebTreeSitterBackend.js";

export interface TreeSitterHeadingNode {
    title: string;
    level: number;
    line: number;
}

export class TreeSitterMarkdownParser {
    private readonly localRequire = createRequire(import.meta.url);
    private backend = new WebTreeSitterBackend();
    private parser: any | null = null;
    private initPromise?: Promise<void>;
    private initError?: Error;
    private readonly wasmPath = resolveMarkdownWasmPath(this.localRequire);

    public isAvailable(): boolean {
        if (isTestEnv()) return false;
        return Boolean(this.wasmPath);
    }

    public async initialize(): Promise<void> {
        if (isTestEnv()) {
            if (!this.initError) {
                this.initError = new Error("markdown_wasm_disabled_in_tests");
            }
            return;
        }
        if (!this.wasmPath) {
            if (!this.initError) {
                this.initError = new Error("markdown_wasm_missing");
            }
            return;
        }
        if (this.parser || this.initPromise || this.initError) {
            return this.initPromise;
        }
        this.initPromise = (async () => {
            try {
                this.parser = await this.backend.getParser("markdown");
            } catch (error) {
                this.initError = error as Error;
                this.parser = null;
            }
        })();
        await this.initPromise;
    }

    public tryParseHeadings(content: string): TreeSitterHeadingNode[] | null {
        if (!this.parser) return null;
        try {
            const tree = this.parser.parse(content);
            const headings: TreeSitterHeadingNode[] = [];
            walk(tree.rootNode, (node: any) => {
                if (!node || !node.isNamed) return;
                if (!isHeadingNode(node)) return;
                const raw = content.slice(node.startIndex, node.endIndex);
                const info = parseHeading(raw);
                if (!info) return;
                headings.push({
                    title: info.title,
                    level: info.level,
                    line: node.startPosition?.row != null ? node.startPosition.row + 1 : 1
                });
            });
            tree.delete();
            return headings;
        } catch {
            return null;
        }
    }
}

function walk(node: any, visit: (node: any) => void): void {
    visit(node);
    const count = node.namedChildCount ?? 0;
    for (let i = 0; i < count; i += 1) {
        const child = node.namedChild(i);
        if (child) {
            walk(child, visit);
        }
    }
}

function isHeadingNode(node: any): boolean {
    const type = node.type ?? "";
    if (type === "atx_heading" || type === "setext_heading" || type === "heading") return true;
    if (type.endsWith("_heading")) return true;
    if (type.includes("heading") && node.endIndex > node.startIndex) return true;
    return false;
}

function parseHeading(raw: string): { title: string; level: number } | null {
    if (!raw) return null;
    const lines = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return null;
    const first = lines[0].trim();
    if (!first) return null;
    let level = 1;
    let title = first;

    const atxMatch = first.match(/^(#{1,6})\s+(.*)$/);
    if (atxMatch) {
        level = atxMatch[1].length;
        title = atxMatch[2].replace(/\s+#+\s*$/, "");
    } else if (lines.length > 1) {
        const underline = lines[1].trim();
        if (/^=+$/.test(underline)) {
            level = 1;
        } else if (/^-+$/.test(underline)) {
            level = 2;
        }
    }

    title = stripInlineMarkdown(title);
    if (!title) return null;
    return { title, level };
}

function stripInlineMarkdown(value: string): string {
    return value
        .replace(/`([^`]+)`/g, "$1")
        .replace(/[\*_~]+/g, "")
        .replace(/<[^>]+>/g, "")
        .trim();
}

function resolveMarkdownWasmPath(localRequire: NodeRequire): string | null {
    const overrideDir = (process.env.SMART_CONTEXT_WASM_DIR || "").trim();
    if (overrideDir) {
        const candidate = path.resolve(overrideDir, "tree-sitter-markdown.wasm");
        return fs.existsSync(candidate) ? candidate : null;
    }

    const candidates: string[] = [];
    try {
        const pkgPath = localRequire.resolve("tree-sitter-wasms/package.json");
        const pkgDir = path.dirname(pkgPath);
        candidates.push(path.join(pkgDir, "out", "tree-sitter-markdown.wasm"));
    } catch {
        // ignore
    }

    try {
        candidates.push(localRequire.resolve("tree-sitter-wasms/out/tree-sitter-markdown.wasm"));
    } catch {
        // ignore
    }

    try {
        const moduleDir = path.dirname(fileURLToPath(import.meta.url));
        candidates.push(path.resolve(moduleDir, "..", "..", "wasm", "tree-sitter-markdown.wasm"));
        candidates.push(path.resolve(moduleDir, "..", "..", "node_modules", "tree-sitter-wasms", "out", "tree-sitter-markdown.wasm"));
    } catch {
        // ignore
    }

    candidates.push(path.resolve(process.cwd(), "node_modules", "tree-sitter-wasms", "out", "tree-sitter-markdown.wasm"));
    candidates.push(path.resolve(process.cwd(), "wasm", "tree-sitter-markdown.wasm"));

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function isTestEnv(): boolean {
    return process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined;
}
