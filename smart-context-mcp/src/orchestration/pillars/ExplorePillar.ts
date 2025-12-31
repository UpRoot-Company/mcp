import path from "path";
import crypto from "crypto";
import { LRUCache } from "lru-cache";
import { InternalToolRegistry } from "../InternalToolRegistry.js";
import { OrchestrationContext } from "../OrchestrationContext.js";
import { ParsedIntent } from "../IntentRouter.js";
import { IntegrityEngine } from "../../integrity/IntegrityEngine.js";
import type { IntegrityReport } from "../../integrity/IntegrityTypes.js";

type ExploreItem = {
    kind: "document_section" | "file_preview" | "file_full" | "symbol" | "directory";
    filePath: string;
    title?: string;
    score?: number;
    range?: { startLine?: number; endLine?: number };
    preview?: string;
    content?: string;
    metadata?: Record<string, unknown>;
    why?: string[];
};

type ExploreResponse = {
    success: boolean;
    status: "ok" | "no_results" | "invalid_args" | "blocked" | "error";
    message?: string;
    query?: string;
    data: { docs: ExploreItem[]; code: ExploreItem[] };
    pack?: { packId: string; hit: boolean; createdAt: number; expiresAt?: number };
    next?: { itemsCursor?: string; contentCursor?: string };
    integrity?: IntegrityReport;
    degraded?: boolean;
    reasons?: string[];
    stats?: Record<string, unknown>;
};

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MAX_FULL_CHARS = 20000;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_DEPTH = 5;
const DEFAULT_SOFT_PRIORITY_RATIO = 0.2;
const DEFAULT_PACK_RESULTS = Number.parseInt(process.env.SMART_CONTEXT_MAX_RESULTS ?? "25", 10) || 25;
const DEFAULT_PACK_TTL_MS = Number.parseInt(process.env.SMART_CONTEXT_EXPLORE_PACK_TTL_MS ?? "600000", 10) || 600000;
const DEFAULT_PACK_CACHE_SIZE = Number.parseInt(process.env.SMART_CONTEXT_EXPLORE_PACK_CACHE_SIZE ?? "100", 10) || 100;

const DOC_EXTENSIONS = new Set([
    ".md", ".mdx", ".txt", ".log", ".docx", ".xlsx", ".pdf", ".html", ".htm", ".css"
]);
const LOG_EXTENSIONS = new Set([".log"]);

const SENSITIVE_FILENAMES = new Set([
    ".env",
    "id_rsa",
    "id_ed25519",
    "known_hosts",
    "authorized_keys"
]);

const SENSITIVE_EXTENSIONS = new Set([
    ".pem",
    ".p12",
    ".pfx",
    ".key",
    ".kdbx"
]);

const SENSITIVE_DIRS = new Set([".ssh", ".gnupg"]);

const BINARY_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".class",
    ".jar"
]);

type ExplorePack = {
    packId: string;
    query: string;
    createdAt: number;
    expiresAt?: number;
    include: { docs: boolean; code: boolean; comments: boolean; logs: boolean };
    docs: ExploreItem[];
    code: ExploreItem[];
};

export class ExplorePillar {
    private static packCache = new LRUCache<string, ExplorePack>({
        max: DEFAULT_PACK_CACHE_SIZE,
        ttl: DEFAULT_PACK_TTL_MS
    });

    constructor(private readonly registry: InternalToolRegistry) {}

    public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<ExploreResponse> {
        const constraints = intent.constraints as any;
        const query = typeof constraints.query === "string" ? constraints.query : undefined;
        const paths = Array.isArray(constraints.paths) ? constraints.paths : [];
        const view = (constraints.view ?? "auto") as "auto" | "preview" | "section" | "full";
        const include = (constraints.include ?? {}) as { docs?: boolean; code?: boolean; comments?: boolean; logs?: boolean };
        const limits = (constraints.limits ?? {}) as {
            maxResults?: number;
            maxChars?: number;
            maxItemChars?: number;
            maxBytes?: number;
            maxFiles?: number;
            timeoutMs?: number;
        };
        const packId = typeof constraints.packId === "string" ? constraints.packId : undefined;
        const fullPaths = Array.isArray(constraints.fullPaths) ? constraints.fullPaths : [];
        const allowSensitive = constraints.allowSensitive === true;
        const allowBinary = constraints.allowBinary === true;
        const allowGlobs = constraints.allowGlobs === true;
        const integrityOptions = IntegrityEngine.resolveOptions(constraints.integrity, "explore");

        if (!query && paths.length === 0) {
            return {
                success: false,
                status: "invalid_args",
                message: "Missing query or paths.",
                data: { docs: [], code: [] }
            };
        }

        const maxResults = Number.isFinite(limits.maxResults) && limits.maxResults! > 0 ? limits.maxResults! : DEFAULT_MAX_RESULTS;
        const maxChars = Number.isFinite(limits.maxChars) && limits.maxChars! > 0
            ? limits.maxChars!
            : (view === "full" ? DEFAULT_MAX_FULL_CHARS : DEFAULT_MAX_CHARS);
        const maxItemChars = Number.isFinite(limits.maxItemChars) && limits.maxItemChars! > 0
            ? limits.maxItemChars!
            : Math.max(400, Math.floor(maxChars / Math.max(1, maxResults)));
        const maxBytes = Number.isFinite(limits.maxBytes) && limits.maxBytes! > 0
            ? limits.maxBytes!
            : Number.parseInt(process.env.SMART_CONTEXT_READ_FILE_MAX_BYTES ?? "0", 10) || undefined;
        const maxFiles = Number.isFinite(limits.maxFiles) && limits.maxFiles! > 0 ? limits.maxFiles! : DEFAULT_MAX_FILES;
        const includeDocs = include.docs !== false;
        const includeCode = include.code !== false;
        const includeComments = include.comments === true;
        const includeLogs = include.logs === true;

        const effectivePackId = query
            ? (packId ?? computeExplorePackId(query, {
                include: { docs: includeDocs, code: includeCode, comments: includeComments, logs: includeLogs },
                intent: constraints.intent,
                paths
            }))
            : undefined;

        const response: ExploreResponse = {
            success: true,
            status: "ok",
            query,
            data: { docs: [], code: [] }
        };
        if (integrityOptions && integrityOptions.mode !== "off") {
            response.integrity = IntegrityEngine.buildPlaceholderReport(integrityOptions).report;
        }

        const reasons: string[] = [];
        let degraded = false;
        let totalChars = 0;

        if (query) {
            const cursorState = parseItemsCursor(constraints.cursor?.items);
            const contentCursorState = parseItemsCursor(constraints.cursor?.content);
            const cachedPack = effectivePackId ? ExplorePillar.packCache.get(effectivePackId) : undefined;
            if (cachedPack) {
                if (constraints.cursor?.content) {
                    const sliced = slicePack(cachedPack, contentCursorState, maxResults, includeDocs, includeCode, includeComments, includeLogs);
                    const expandedDocs = await Promise.all(sliced.docs.map((item) => this.expandDocContent(item, maxChars, context)));
                    const expandedCode = await Promise.all(sliced.code.map((item) => this.expandCodeContent(item, maxChars, context)));
                    response.data.docs = expandedDocs;
                    response.data.code = expandedCode;
                    if (sliced.nextCursor) {
                        response.next = { contentCursor: sliced.nextCursor };
                    }
                } else {
                    const sliced = slicePack(cachedPack, cursorState, maxResults, includeDocs, includeCode, includeComments, includeLogs);
                    response.data.docs = sliced.docs;
                    response.data.code = sliced.code;
                    if (sliced.nextCursor) {
                        response.next = { itemsCursor: sliced.nextCursor };
                    }
                }
                response.pack = {
                    packId: cachedPack.packId,
                    hit: true,
                    createdAt: cachedPack.createdAt,
                    expiresAt: cachedPack.expiresAt
                };
            } else {
                const packMaxResults = Math.max(maxResults, DEFAULT_PACK_RESULTS);
                let docsForPack: ExploreItem[] = [];
                let codeForPack: ExploreItem[] = [];

                if (includeDocs || includeComments) {
                    const docResults = await this.runTool(context, "doc_search", {
                        query,
                        output: "compact",
                        maxResults: packMaxResults,
                        includeEvidence: false,
                        packId: undefined,
                        includeComments
                    });
                    const sections = Array.isArray(docResults?.results) ? docResults.results : [];
                    const filtered = sections.filter((section: any) => {
                        if (section?.kind === "code_comment") return includeComments;
                        if (isLogPath(section?.filePath)) {
                            return includeLogs || includeDocs;
                        }
                        return includeDocs;
                    });
                    const docs = filtered.map((section: any) => ({
                        kind: "document_section",
                        filePath: section.filePath ?? "",
                        title: section.heading ?? section.sectionPath?.slice?.(-1)?.[0],
                        score: section.scores?.final,
                        range: { startLine: section.range?.startLine, endLine: section.range?.endLine },
                        preview: truncate(section.preview ?? "", maxItemChars),
                        metadata: {
                            ...(section.kind ? { kind: section.kind } : {}),
                            ...(Array.isArray(section.sectionPath) ? { headingPath: section.sectionPath } : {})
                        },
                        why: ["doc_search"]
                    }));
                    docsForPack = docs;
                    response.data.docs = docs.slice(0, maxResults);
                    if (docResults?.degraded) {
                        degraded = true;
                        if (Array.isArray(docResults?.reasons)) {
                            reasons.push(...docResults.reasons);
                        }
                    }
                }

                if (includeCode) {
                    const codeResults = await this.runTool(context, "search_project", {
                        query,
                        maxResults: packMaxResults,
                        type: "file"
                    });
                    const results = Array.isArray(codeResults?.results) ? codeResults.results : [];
                    const codeItems = results.map((item: any) => ({
                        kind: "file_preview",
                        filePath: item.path ?? "",
                        preview: truncate(item.context ?? "", maxItemChars),
                        range: item.line ? { startLine: item.line, endLine: item.line } : undefined,
                        score: item.score,
                        why: [item.type ?? "search_project"]
                    }));
                    codeForPack = codeItems;
                    response.data.code = codeItems.slice(0, maxResults);
                    if (codeResults?.degraded) {
                        degraded = true;
                        if (codeResults?.reason) {
                            reasons.push(codeResults.reason);
                        }
                    }
                }

                if (effectivePackId) {
                    const createdAt = Date.now();
                    const expiresAt = createdAt + DEFAULT_PACK_TTL_MS;
                    const pack: ExplorePack = {
                        packId: effectivePackId,
                        query,
                        createdAt,
                        expiresAt,
                        include: { docs: includeDocs, code: includeCode, comments: includeComments, logs: includeLogs },
                        docs: docsForPack,
                        code: codeForPack
                    };
                    ExplorePillar.packCache.set(effectivePackId, pack);
                    response.pack = { packId: effectivePackId, hit: false, createdAt, expiresAt };
                    const nextCursor = computeNextCursor(pack, cursorState, maxResults, includeDocs, includeCode, includeComments, includeLogs);
                    if (nextCursor) {
                        response.next = { itemsCursor: nextCursor };
                    }
                }
            }
        }

        if (paths.length > 0) {
            const expanded = await this.expandPaths(paths, {
                allowGlobs,
                maxFiles,
                includeDocs,
                includeCode
            });

            if (expanded.blocked) {
                return {
                    success: false,
                    status: "invalid_args",
                    message: expanded.message ?? "Invalid paths.",
                    data: { docs: [], code: [] }
                };
            }

            const selected = applySoftPriority(expanded.entries, maxFiles, includeDocs, includeCode);
            const fullPathSet = new Set(fullPaths);

            for (const entry of selected) {
                if (!includeDocs && isDocPath(entry.path)) continue;
                if (!includeCode && !isDocPath(entry.path)) continue;

                const wantsFull = view === "full" && (fullPaths.length === 0 || fullPathSet.has(entry.path));
                if (wantsFull) {
                    const blocked = this.isBlockedFullRead(entry.path, allowSensitive, allowBinary);
                    if (blocked) {
                        return {
                            success: false,
                            status: "blocked",
                            message: `Full read blocked for sensitive/binary path: ${entry.path}`,
                            data: { docs: [], code: [] }
                        };
                    }
                    if (typeof maxBytes === "number" && entry.size && entry.size > maxBytes) {
                        return {
                            success: false,
                            status: "blocked",
                            message: `Full read blocked by maxBytes for ${entry.path}.`,
                            data: { docs: [], code: [] }
                        };
                    }
                }

                const item = await this.buildItemForPath(entry.path, {
                    view,
                    maxChars,
                    maxItemChars,
                    allowSensitive,
                    allowBinary,
                    wantsFull,
                    section: constraints.section
                }, context);

                if (item.blocked) {
                    return {
                        success: false,
                        status: "blocked",
                        message: item.message ?? "Full read blocked.",
                        data: { docs: [], code: [] }
                    };
                }

                if (item.degraded) {
                    degraded = true;
                    if (item.reason) reasons.push(item.reason);
                }

                const payloadItem = item.value;
                if (!payloadItem) continue;

                const contentLength = (payloadItem.content ?? payloadItem.preview ?? "").length;
                if (view === "full") {
                    if (totalChars + contentLength > maxChars) {
                        return {
                            success: false,
                            status: "blocked",
                            message: "Full read blocked by maxChars. Increase limits.maxChars and retry.",
                            data: { docs: [], code: [] }
                        };
                    }
                } else {
                    if (totalChars + contentLength > maxChars) {
                        degraded = true;
                        reasons.push("budget_exceeded");
                        break;
                    }
                }
                totalChars += contentLength;

                if (isDocPath(entry.path)) {
                    response.data.docs.push(payloadItem);
                } else {
                    response.data.code.push(payloadItem);
                }
            }
        }

        if (response.data.docs.length === 0 && response.data.code.length === 0) {
            response.status = "no_results";
            response.message = "No results found.";
        }

        if (degraded) {
            response.degraded = true;
            response.reasons = Array.from(new Set(reasons));
        }

        return response;
    }

    private async buildItemForPath(
        filePath: string,
        options: {
            view: "auto" | "preview" | "section" | "full";
            maxChars: number;
            maxItemChars: number;
            allowSensitive: boolean;
            allowBinary: boolean;
            wantsFull: boolean;
            section?: { sectionId?: string; headingPath?: string[]; includeSubsections?: boolean };
        },
        context: OrchestrationContext
    ): Promise<{ value?: ExploreItem; degraded?: boolean; reason?: string; blocked?: boolean; message?: string }> {
        const docPath = isDocPath(filePath);
        const safePreview = (value: string) => truncate(value ?? "", options.maxItemChars);

        if (options.wantsFull) {
            if (docPath) {
                const section = options.section ?? {};
                const result = await this.runTool(context, "doc_section", {
                    filePath,
                    sectionId: section.sectionId,
                    headingPath: section.headingPath,
                    includeSubsections: section.includeSubsections === true,
                    mode: "raw",
                    maxChars: options.maxChars
                });
                if (result?.truncated) {
                    return { blocked: true, message: `Full read blocked by maxChars for ${filePath}.` };
                }
                return {
                    value: {
                        kind: "file_full",
                        filePath,
                        content: result?.content ?? "",
                        range: result?.section?.range ? { startLine: result.section.range.startLine, endLine: result.section.range.endLine } : undefined,
                        why: ["doc_section"]
                    }
                };
            }

            const content = await this.runTool(context, "read_code", { filePath, view: "full" });
            const text = typeof content === "string" ? content : "";
            if (text.length > options.maxChars) {
                return { blocked: true, message: `Full read blocked by maxChars for ${filePath}.` };
            }
            return {
                value: {
                    kind: "file_full",
                    filePath,
                    content: text,
                    why: ["read_code"]
                }
            };
        }

        if (docPath) {
            const section = options.section ?? {};
            if (section.sectionId || section.headingPath) {
                const result = await this.runTool(context, "doc_section", {
                    filePath,
                    sectionId: section.sectionId,
                    headingPath: section.headingPath,
                    includeSubsections: section.includeSubsections === true,
                    mode: "preview",
                    maxChars: options.maxItemChars
                });
                const preview = safePreview(result?.content ?? "");
                return {
                    value: {
                        kind: "document_section",
                        filePath,
                        preview,
                        range: result?.section?.range ? { startLine: result.section.range.startLine, endLine: result.section.range.endLine } : undefined,
                        why: ["doc_section"]
                    },
                    degraded: result?.truncated === true,
                    reason: result?.truncated === true ? "truncated" : undefined
                };
            }
            const skeleton = await this.runTool(context, "doc_skeleton", { filePath });
            const preview = safePreview(skeleton?.skeleton ?? "");
            return {
                value: {
                    kind: "file_preview",
                    filePath,
                    preview,
                    why: ["doc_skeleton"]
                }
            };
        }

        const content = await this.runTool(context, "read_code", { filePath, view: "skeleton" });
        const preview = safePreview(typeof content === "string" ? content : "");
        return {
            value: {
                kind: "file_preview",
                filePath,
                preview,
                why: ["read_code"]
            }
        };
    }

    private async expandDocContent(item: ExploreItem, maxChars: number, context: OrchestrationContext): Promise<ExploreItem> {
        const headingPath = Array.isArray(item.metadata?.headingPath) ? item.metadata?.headingPath : undefined;
        const result = await this.runTool(context, "doc_section", {
            filePath: item.filePath,
            headingPath,
            includeSubsections: false,
            mode: "raw",
            maxChars
        });
        return {
            ...item,
            content: typeof result?.content === "string" ? result.content : item.preview
        };
    }

    private async expandCodeContent(item: ExploreItem, maxChars: number, context: OrchestrationContext): Promise<ExploreItem> {
        const startLine = item.range?.startLine;
        const endLine = item.range?.endLine;
        const lineRange = startLine ? `${startLine}-${endLine ?? startLine}` : undefined;
        const result = await this.runTool(context, "read_code", {
            filePath: item.filePath,
            view: lineRange ? "fragment" : "skeleton",
            lineRange
        });
        const content = typeof result === "string" ? result : "";
        return {
            ...item,
            content: truncate(content, maxChars)
        };
    }

    private async expandPaths(
        paths: string[],
        options: { allowGlobs: boolean; maxFiles: number; includeDocs: boolean; includeCode: boolean }
    ): Promise<{ entries: Array<{ path: string; mtime?: number; size?: number }>; blocked?: boolean; message?: string }> {
        const entries: Array<{ path: string; mtime?: number; size?: number }> = [];
        const seen = new Set<string>();

        for (const rawPath of paths) {
            if (isGlob(rawPath) && !options.allowGlobs) {
                return { entries: [], blocked: true, message: `Glob patterns are not allowed: ${rawPath}` };
            }

            if (isGlob(rawPath) && options.allowGlobs) {
                try {
                    const matches = await this.registry.execute("search_files", {
                        patterns: [rawPath],
                        groupByFile: true,
                        deduplicateByContent: true,
                        maxResults: options.maxFiles
                    });
                    for (const item of matches ?? []) {
                        const filePath = item?.filePath;
                        if (!filePath || seen.has(filePath)) continue;
                        seen.add(filePath);
                        const stat = await this.registry.execute("stat_file", { path: filePath });
                        entries.push({ path: filePath, mtime: stat?.mtime, size: stat?.size });
                        if (entries.length >= options.maxFiles) break;
                    }
                } catch {
                    continue;
                }
                continue;
            }

            const listed = await this.registry.execute("list_files", {
                basePath: rawPath,
                depth: DEFAULT_DEPTH,
                maxFiles: options.maxFiles
            });
            for (const item of listed ?? []) {
                const filePath = item?.path;
                if (!filePath || seen.has(filePath)) continue;
                seen.add(filePath);
                entries.push({ path: filePath, mtime: item?.mtime, size: item?.size });
                if (entries.length >= options.maxFiles) break;
            }
            if (entries.length >= options.maxFiles) break;
        }

        return { entries };
    }

    private isBlockedFullRead(filePath: string, allowSensitive: boolean, allowBinary: boolean): boolean {
        if (!allowSensitive && isSensitivePath(filePath)) return true;
        if (!allowBinary && isBinaryPath(filePath)) return true;
        return false;
    }

    private async runTool(context: OrchestrationContext, tool: string, args: any) {
        const started = Date.now();
        const output = await this.registry.execute(tool, args);
        context.addStep({
            id: `${tool}_${context.getFullHistory().length + 1}`,
            tool,
            args,
            output,
            status: output?.success === false || output?.isError ? "failure" : "success",
            duration: Date.now() - started
        });
        return output;
    }
}

function isGlob(value: string): boolean {
    return /[*?[\]{}]/.test(value);
}

function isDocPath(filePath: string): boolean {
    return DOC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isLogPath(filePath?: string): boolean {
    if (!filePath) return false;
    return LOG_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isSensitivePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (segments.some(segment => SENSITIVE_DIRS.has(segment))) return true;

    const base = path.basename(normalized);
    if (SENSITIVE_FILENAMES.has(base)) return true;
    if (base.startsWith(".env")) return true;

    const ext = path.extname(base).toLowerCase();
    if (SENSITIVE_EXTENSIONS.has(ext)) return true;

    return false;
}

function isBinaryPath(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (DOC_EXTENSIONS.has(ext)) return false;
    return BINARY_EXTENSIONS.has(ext);
}

function applySoftPriority(
    entries: Array<{ path: string; mtime?: number; size?: number }>,
    maxFiles: number,
    includeDocs: boolean,
    includeCode: boolean
): Array<{ path: string; mtime?: number; size?: number }> {
    const sorted = entries.slice().sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    if (!includeDocs && !includeCode) return [];

    const preferred = sorted.filter(entry => {
        if (includeDocs && includeCode) return isDocPath(entry.path);
        if (includeDocs) return isDocPath(entry.path);
        return !isDocPath(entry.path);
    });

    const preferredQuota = Math.min(Math.floor(maxFiles * DEFAULT_SOFT_PRIORITY_RATIO), preferred.length);
    const selected: Array<{ path: string; mtime?: number; size?: number }> = [];
    const seen = new Set<string>();

    for (let i = 0; i < preferredQuota; i += 1) {
        const entry = preferred[i];
        if (!entry) continue;
        selected.push(entry);
        seen.add(entry.path);
    }

    for (const entry of sorted) {
        if (selected.length >= maxFiles) break;
        if (seen.has(entry.path)) continue;
        selected.push(entry);
        seen.add(entry.path);
    }

    return selected;
}

function truncate(text: string, maxChars: number): string {
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;
    const value = String(text ?? "");
    if (value.length <= limit) return value;
    return `${value.slice(0, Math.max(1, limit - 1))}…`;
}

function computeExplorePackId(query: string, options: Record<string, unknown>): string {
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

function parseItemsCursor(raw?: string): { docs: number; code: number } {
    if (!raw || typeof raw !== "string") return { docs: 0, code: 0 };
    try {
        const parsed = JSON.parse(raw);
        const docs = Number.isFinite(parsed?.docs) ? Math.max(0, parsed.docs) : 0;
        const code = Number.isFinite(parsed?.code) ? Math.max(0, parsed.code) : 0;
        return { docs, code };
    } catch {
        return { docs: 0, code: 0 };
    }
}

function encodeItemsCursor(cursor: { docs: number; code: number }): string {
    return JSON.stringify({ docs: Math.max(0, cursor.docs), code: Math.max(0, cursor.code) });
}

function filterDocsByInclude(
    docs: ExploreItem[],
    includeDocs: boolean,
    includeComments: boolean,
    includeLogs: boolean
): ExploreItem[] {
    if (!includeDocs && !includeComments && !includeLogs) return [];
    return docs.filter(item => {
        if (item.metadata?.kind === "code_comment") return includeComments;
        if (isLogPath(item.filePath)) return includeLogs || includeDocs;
        return includeDocs;
    });
}

function slicePack(
    pack: ExplorePack,
    cursor: { docs: number; code: number },
    maxResults: number,
    includeDocs: boolean,
    includeCode: boolean,
    includeComments: boolean,
    includeLogs: boolean
): { docs: ExploreItem[]; code: ExploreItem[]; nextCursor?: string } {
    const docsFiltered = filterDocsByInclude(pack.docs, includeDocs, includeComments, includeLogs);
    const codeFiltered = includeCode ? pack.code : [];
    const docs = docsFiltered.slice(cursor.docs, cursor.docs + maxResults);
    const code = codeFiltered.slice(cursor.code, cursor.code + maxResults);
    const nextDocs = cursor.docs + docs.length;
    const nextCode = cursor.code + code.length;
    const hasMore = nextDocs < docsFiltered.length || nextCode < codeFiltered.length;
    return {
        docs,
        code,
        nextCursor: hasMore ? encodeItemsCursor({ docs: nextDocs, code: nextCode }) : undefined
    };
}

function computeNextCursor(
    pack: ExplorePack,
    cursor: { docs: number; code: number },
    maxResults: number,
    includeDocs: boolean,
    includeCode: boolean,
    includeComments: boolean,
    includeLogs: boolean
): string | undefined {
    const sliced = slicePack(pack, cursor, maxResults, includeDocs, includeCode, includeComments, includeLogs);
    return sliced.nextCursor;
}
