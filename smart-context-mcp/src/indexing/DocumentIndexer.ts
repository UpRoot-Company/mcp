import * as path from "path";
import ignore from "ignore";
import { IFileSystem } from "../platform/FileSystem.js";
import { IndexDatabase } from "./IndexDatabase.js";
import { DocumentProfiler } from "../documents/DocumentProfiler.js";
import { DocumentChunkRepository, StoredDocumentChunk } from "./DocumentChunkRepository.js";
import { HeadingChunker } from "../documents/chunking/HeadingChunker.js";
import { DocumentKind, DocumentOutlineOptions } from "../types.js";
import { EmbeddingRepository } from "./EmbeddingRepository.js";

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
        options?: { outlineOptions?: DocumentOutlineOptions; embeddingRepository?: EmbeddingRepository }
    ) {
        this.chunkRepo = new DocumentChunkRepository(indexDatabase);
        this.chunker = new HeadingChunker();
        this.profiler = new DocumentProfiler(rootPath);
        this.outlineOptions = options?.outlineOptions ?? {};
        this.embeddingRepository = options?.embeddingRepository;
    }

    private outlineOptions: DocumentOutlineOptions;
    private readonly embeddingRepository?: EmbeddingRepository;

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
}

function inferKind(filePath: string): DocumentKind {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".mdx") return "mdx";
    if (ext === ".md") return "markdown";
    return "unknown";
}
