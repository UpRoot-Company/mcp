import * as path from "path";
import ignore from "ignore";
import { IFileSystem } from "../platform/FileSystem.js";
import { IndexDatabase } from "./IndexDatabase.js";
import { DocumentProfiler } from "../documents/DocumentProfiler.js";
import { DocumentChunkRepository, StoredDocumentChunk } from "./DocumentChunkRepository.js";
import { HeadingChunker } from "../documents/chunking/HeadingChunker.js";
import { DocumentKind, DocumentOutlineOptions } from "../types.js";
import { EmbeddingRepository } from "./EmbeddingRepository.js";
import { EmbeddingProviderFactory } from "../embeddings/EmbeddingProviderFactory.js";

const SUPPORTED_DOC_EXTENSIONS = new Set<string>([".md", ".mdx"]);

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
        const content = await this.fileSystem.readFile(relativePath);
        const kind = inferKind(relativePath);

        const fileRecord = this.indexDatabase.getOrCreateFile(relativePath, stats.mtime, kind);
        this.embeddingRepository?.deleteEmbeddingsForFileId(fileRecord.id);

        const profile = this.profiler.profile({
            filePath: relativePath,
            content,
            kind,
            options: this.outlineOptions
        });

        const chunks = this.chunker.chunk(relativePath, kind, profile.outline, content, this.outlineOptions);
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
    if (ext === ".mdx") return "mdx";
    if (ext === ".md") return "markdown";
    return "unknown";
}

function l2Norm(vector: Float32Array): number {
    let sum = 0;
    for (const v of vector) {
        sum += v * v;
    }
    return Math.sqrt(sum);
}
