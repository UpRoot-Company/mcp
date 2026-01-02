import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { WebTreeSitterBackend } from "../../ast/WebTreeSitterBackend.js";
import { extractHtmlHeadings, extractHtmlReferences } from "./HtmlTextExtractor.js";

export interface TreeSitterHtmlHeadingNode {
    title: string;
    level: number;
    line: number;
}

export interface TreeSitterHtmlLinkNode {
    href: string;
    line: number;
}

export class TreeSitterHtmlParser {
    private readonly localRequire = createRequire(import.meta.url);
    private backend = new WebTreeSitterBackend();
    private parser: any | null = null;
    private initPromise?: Promise<void>;
    private initError?: Error;

    public isAvailable(): boolean {
        if (isTestEnv()) return false;
        return Boolean(resolveHtmlWasmPath(this.localRequire));
    }

    public async initialize(): Promise<void> {
        if (isTestEnv()) {
            if (!this.initError) {
                this.initError = new Error("html_wasm_disabled_in_tests");
            }
            return;
        }
        if (!this.isAvailable()) {
            if (!this.initError) {
                this.initError = new Error("html_wasm_missing");
            }
            return;
        }
        if (this.parser || this.initPromise || this.initError) {
            return this.initPromise;
        }
        this.initPromise = (async () => {
            try {
                this.parser = await this.backend.getParser("html");
            } catch (error) {
                this.initError = error as Error;
                this.parser = null;
            }
        })();
        await this.initPromise;
    }

    public tryParseHeadings(content: string): TreeSitterHtmlHeadingNode[] | null {
        // Without a guaranteed stable node schema across grammars, we rely on a conservative fallback:
        // - tree-sitter availability gates this path, but extraction is done via HTML-level heuristics.
        // - This avoids shipping a brittle node-walking implementation that depends on grammar internals.
        if (!this.parser) return null;
        return extractHtmlHeadings(content);
    }

    public tryParseReferences(content: string): TreeSitterHtmlLinkNode[] | null {
        if (!this.parser) return null;
        const refs = extractHtmlReferences(content);
        return refs.map(ref => ({ href: ref.href, line: ref.line }));
    }
}

function resolveHtmlWasmPath(localRequire: NodeRequire): string | null {
    const overrideDir = (process.env.SMART_CONTEXT_WASM_DIR || "").trim();
    if (overrideDir) {
        const candidate = path.resolve(overrideDir, "tree-sitter-html.wasm");
        return fs.existsSync(candidate) ? candidate : null;
    }
    try {
        const pkgPath = localRequire.resolve("tree-sitter-wasms/package.json");
        const pkgDir = path.dirname(pkgPath);
        const candidate = path.join(pkgDir, "out", "tree-sitter-html.wasm");
        return fs.existsSync(candidate) ? candidate : null;
    } catch {
        // ignore
    }
    const cwdCandidates = [
        path.resolve(process.cwd(), "node_modules", "tree-sitter-wasms", "out", "tree-sitter-html.wasm"),
        path.resolve(process.cwd(), "wasm", "tree-sitter-html.wasm")
    ];
    for (const candidate of cwdCandidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function isTestEnv(): boolean {
    return process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined;
}
