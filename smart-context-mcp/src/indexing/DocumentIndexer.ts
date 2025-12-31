import * as path from "path";
import * as fs from "fs";
import ignore from "ignore";
import { IFileSystem } from "../platform/FileSystem.js";
import { IndexDatabase } from "./IndexDatabase.js";
import { DocumentProfiler } from "../documents/DocumentProfiler.js";
import { DocumentChunkRepository, StoredDocumentChunk } from "./DocumentChunkRepository.js";
import { HeadingChunker } from "../documents/chunking/HeadingChunker.js";
import { DocumentKind, DocumentOutlineOptions } from "../types.js";
import { EmbeddingRepository } from "./EmbeddingRepository.js";
import { EmbeddingProviderFactory } from "../embeddings/EmbeddingProviderFactory.js";
import { extractHtmlTextPreserveLines } from "../documents/html/HtmlTextExtractor.js";
import { extractDocxAsHtml, DocxExtractError } from "../documents/extractors/DocxExtractor.js";
import { extractXlsxAsText, XlsxExtractError } from "../documents/extractors/XlsxExtractor.js";
import { extractPdfAsText, PdfExtractError } from "../documents/extractors/PdfExtractor.js";

const SUPPORTED_DOC_EXTENSIONS = new Set<string>([".md", ".mdx", ".txt", ".log", ".html", ".htm", ".css", ".docx", ".xlsx", ".pdf"]);
const WELL_KNOWN_TEXT_FILES = new Set<string>([
    "README",
    "LICENSE",
    "NOTICE",
    "CHANGELOG",
    "CODEOWNERS",
    ".gitignore",
    ".mcpignore",
    ".editorconfig"
]);

const DEFAULT_MAX_FILE_BYTES = 2_000_000; // 2MB
const DEFAULT_SAMPLE_HEAD_BYTES = 600_000;
const DEFAULT_SAMPLE_TAIL_BYTES = 300_000;

export class DocumentIndexer {
    private ignoreFilter: ReturnType<typeof ignore.default> = (ignore as unknown as () => any)();
    private readonly chunkRepo: DocumentChunkRepository;
    private readonly chunker: HeadingChunker;
    private readonly profiler: DocumentProfiler;

    constructor(
        private readonly rootPath: string,
        private readonly fileSystem: IFileSystem,
        private readonly indexDatabase: IndexDatabase,
        options?: {
            outlineOptions?: DocumentOutlineOptions;
            embeddingRepository?: EmbeddingRepository;
            embeddingProviderFactory?: EmbeddingProviderFactory;
        }
    ) {
        this.chunkRepo = new DocumentChunkRepository(indexDatabase);
        this.chunker = new HeadingChunker();
        this.profiler = new DocumentProfiler(rootPath);
        this.outlineOptions = options?.outlineOptions ?? {};
        this.embeddingRepository = options?.embeddingRepository;
        this.embeddingProviderFactory = options?.embeddingProviderFactory;
    }

    private outlineOptions: DocumentOutlineOptions;
    private readonly embeddingRepository?: EmbeddingRepository;
    private readonly embeddingProviderFactory?: EmbeddingProviderFactory;

    public updateIgnorePatterns(patterns: string[]): void {
        this.ignoreFilter = (ignore as unknown as () => any)().add(patterns ?? []);
    }

    public isSupported(filePath: string): boolean {
        const base = path.basename(filePath);
        if (WELL_KNOWN_TEXT_FILES.has(base)) return true;
        const ext = path.extname(filePath).toLowerCase();
        return SUPPORTED_DOC_EXTENSIONS.has(ext);
    }

    public shouldIgnore(filePath: string): boolean {
        const relPath = this.toRelative(filePath);
        if (!relPath) return true;
        return this.ignoreFilter.ignores(relPath);
    }

    public async indexFile(filePath: string): Promise<void> {
        if (!this.isSupported(filePath)) return;
        const relativePath = this.toRelative(filePath);
        if (!relativePath) return;
        if (this.shouldIgnore(relativePath)) return;

        const stats = await this.fileSystem.stat(relativePath);
        const ext = path.extname(relativePath).toLowerCase();
        const isDocx = ext === ".docx";
        const isXlsx = ext === ".xlsx";
        const isPdf = ext === ".pdf";
        const kind = isDocx ? "html" : (isXlsx || isPdf ? "text" : inferKind(relativePath));
        let rawContent = "";
        if (isDocx) {
            const absPath = path.resolve(this.rootPath, relativePath);
            try {
                const extracted = await extractDocxAsHtml(absPath);
                rawContent = extracted.html ?? "";
            } catch (error: any) {
                const reason = error instanceof DocxExtractError ? error.reason : "docx_parse_failed";
                console.warn(`[DocumentIndexer] Failed to extract DOCX (${relativePath}): ${reason}`);
                return;
            }
        } else if (isXlsx) {
            const absPath = path.resolve(this.rootPath, relativePath);
            try {
                const extracted = await extractXlsxAsText(absPath);
                rawContent = extracted.text ?? "";
            } catch (error: any) {
                const reason = error instanceof XlsxExtractError ? error.reason : "xlsx_parse_failed";
                console.warn(`[DocumentIndexer] Failed to extract XLSX (${relativePath}): ${reason}`);
                return;
            }
        } else if (isPdf) {
            const absPath = path.resolve(this.rootPath, relativePath);
            try {
                const extracted = await extractPdfAsText(absPath);
                rawContent = extracted.text ?? "";
            } catch (error: any) {
                const reason = error instanceof PdfExtractError ? error.reason : "pdf_parse_failed";
                console.warn(`[DocumentIndexer] Failed to extract PDF (${relativePath}): ${reason}`);
                return;
            }
        } else {
            rawContent = await this.readDocumentContent(relativePath, stats.size);
        }
        const contentForChunking = kind === "html" ? extractHtmlTextPreserveLines(rawContent) : rawContent;

        const fileRecord = this.indexDatabase.getOrCreateFile(relativePath, stats.mtime, kind);
        this.embeddingRepository?.deleteEmbeddingsForFileId(fileRecord.id);

        const profile = this.profiler.profile({
            filePath: relativePath,
            content: rawContent,
            kind,
            options: this.outlineOptions
        });

        const chunks = this.chunker.chunk(relativePath, kind, profile.outline, contentForChunking, this.outlineOptions);
        const stored = chunks.map(chunk => ({
            ...chunk,
            filePath: relativePath
        })) as StoredDocumentChunk[];

        this.chunkRepo.upsertChunksForFile(relativePath, stored);
        if (this.shouldEagerEmbed()) {
            await this.embedChunks(stored);
        }
    }

    public deleteFile(filePath: string): void {
        const relativePath = this.toRelative(filePath);
        if (!relativePath) return;
        this.chunkRepo.deleteChunksForFile(relativePath);
        this.indexDatabase.deleteFile(relativePath);
    }

    public async rebuildAll(): Promise<void> {
        const files = await this.fileSystem.listFiles(this.rootPath);
        for (const absPath of files) {
            if (!this.isSupported(absPath)) continue;
            if (this.shouldIgnore(absPath)) continue;
            try {
                await this.indexFile(absPath);
            } catch {
                // best-effort for now
            }
        }
    }

    private toRelative(filePath: string): string | null {
        const absolute = path.isAbsolute(filePath)
            ? path.normalize(filePath)
            : path.resolve(this.rootPath, filePath);
        const relative = path.relative(this.rootPath, absolute).replace(/\\/g, "/");
        if (relative.startsWith("..")) {
            return null;
        }
        return relative || ".";
    }

    private async readDocumentContent(relativePath: string, sizeBytes: number): Promise<string> {
        const maxBytes = Number(process.env.SMART_CONTEXT_DOC_MAX_FILE_BYTES ?? DEFAULT_MAX_FILE_BYTES);
        const headBytes = Number(process.env.SMART_CONTEXT_DOC_SAMPLE_HEAD_BYTES ?? DEFAULT_SAMPLE_HEAD_BYTES);
        const tailBytes = Number(process.env.SMART_CONTEXT_DOC_SAMPLE_TAIL_BYTES ?? DEFAULT_SAMPLE_TAIL_BYTES);

        let content: string;
        if (Number.isFinite(maxBytes) && maxBytes > 0 && sizeBytes > maxBytes) {
            content = await this.readSampledUtf8(relativePath, Math.max(1, headBytes), Math.max(0, tailBytes));
        } else {
            content = await this.fileSystem.readFile(relativePath);
        }
        return content;
    }

    private async readSampledUtf8(relativePath: string, headBytes: number, tailBytes: number): Promise<string> {
        // Best-effort sampling: use fs when possible (NodeFileSystem), fall back to full read otherwise.
        try {
            const absPath = path.resolve(this.rootPath, relativePath);
            const handle = await fs.promises.open(absPath, "r");
            try {
                const stat = await handle.stat();
                const size = stat.size;
                const headLen = Math.min(headBytes, size);
                const tailLen = Math.min(tailBytes, Math.max(0, size - headLen));

                const head = Buffer.alloc(headLen);
                await handle.read(head, 0, headLen, 0);

                let tailText = "";
                if (tailLen > 0) {
                    const tail = Buffer.alloc(tailLen);
                    await handle.read(tail, 0, tailLen, size - tailLen);
                    tailText = tail.toString("utf8");
                }

                const marker = `\n[[sampling_applied bytes=${size} head=${headLen} tail=${tailLen}]]\n`;
                return `${head.toString("utf8")}${marker}${tailText}`;
            } finally {
                await handle.close();
            }
        } catch {
            const full = await this.fileSystem.readFile(relativePath);
            const marker = `\n[[sampling_applied]]\n`;
            if (full.length <= headBytes + tailBytes) return full;
            const head = full.slice(0, headBytes);
            const tail = tailBytes > 0 ? full.slice(-tailBytes) : "";
            return `${head}${marker}${tail}`;
        }
    }

    private shouldEagerEmbed(): boolean {
        return process.env.SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER === "true";
    }

    private async embedChunks(chunks: StoredDocumentChunk[]): Promise<void> {
        if (!this.embeddingRepository || !this.embeddingProviderFactory) return;
        if (chunks.length === 0) return;
        const provider = await this.embeddingProviderFactory.getProvider();
        if (provider.provider === "disabled") return;

        const batchSize = this.embeddingProviderFactory.getConfig().batchSize ?? 16;
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const vectors = await provider.embed(batch.map(chunk => chunk.text));
            for (let idx = 0; idx < batch.length; idx += 1) {
                const chunk = batch[idx];
                const vector = vectors[idx];
                if (!vector) continue;
                if (provider.dims === 0) {
                    provider.dims = vector.length;
                }
                this.embeddingRepository.upsertEmbedding(chunk.id, {
                    provider: provider.provider,
                    model: provider.model,
                    dims: vector.length,
                    vector,
                    norm: l2Norm(vector)
                });
            }
        }
    }
}

function inferKind(filePath: string): DocumentKind {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".html" || ext === ".htm") return "html";
    if (ext === ".css") return "css";
    if (ext === ".mdx") return "mdx";
    if (ext === ".md") return "markdown";
    if (ext === ".txt") return "text";
    if (ext === ".log") return "text";
    if (ext === ".docx") return "html";
    if (ext === ".xlsx") return "text";
    if (ext === ".pdf") return "text";
    const base = path.basename(filePath);
    if (WELL_KNOWN_TEXT_FILES.has(base)) return "text";
    return "unknown";
}

function l2Norm(vector: Float32Array): number {
    let sum = 0;
    for (const v of vector) {
        sum += v * v;
    }
    return Math.sqrt(sum);
}
