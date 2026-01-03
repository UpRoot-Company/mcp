import path from 'path';
import { TrigramIndex } from '../TrigramIndex.js';
import { SymbolIndex } from '../../types.js';
import { IFileSystem } from '../../platform/FileSystem.js';

const MAX_CANDIDATE_FILES = 400;

export class CandidateCollector {
    constructor(
        private rootPath: string,
        private trigramIndex: TrigramIndex,
        private symbolIndex?: SymbolIndex,
        private fileSystem?: IFileSystem // Add optional fileSystem injection
    ) {}

    public async collectHybridCandidates(
        keywords: string[],
        options?: { waitForTrigram?: boolean }
    ): Promise<Set<string>> {
        const candidates = new Set<string>();
        const debug = process.env.SMART_CONTEXT_DEBUG === 'true';
        // CHANGED: Don't wait for trigram index to be ready on first call
        // This prevents 20+ second timeouts on initial explore calls
        const waitForTrigram = options?.waitForTrigram === true; // Changed from !== false

        // Source 1: Trigram index
        const trigramQuery = keywords.join(' ');
        const trigramResults = await this.trigramIndex.search(trigramQuery, MAX_CANDIDATE_FILES * 2, {
            waitForReady: waitForTrigram
        });
        for (const result of trigramResults) {
            candidates.add(result.filePath);
        }
        if (debug) {
            console.log(`[Search] Trigram candidates: ${trigramResults.length}`);
        }

        // Source 2: Filename matching
        const filenameMatches = this.findByFilename(keywords);
        for (const path of filenameMatches) {
            candidates.add(path);
        }
        if (debug) {
            console.log(`[Search] Filename matches: ${filenameMatches.length}`);
        }

        // Source 3: Symbol index
        if (this.symbolIndex) {
            const symbolMatches = await this.findBySymbolName(keywords);
            for (const path of symbolMatches) {
                candidates.add(path);
            }
            if (debug) {
                console.log(`[Search] Symbol matches: ${symbolMatches.length}`);
            }
        }

        // Source 4: Fallback
        if (candidates.size < 20) {
            const allFiles = this.trigramIndex.listFiles();
            const fallback = allFiles.slice(0, MAX_CANDIDATE_FILES * 3);
            for (const file of fallback) {
                candidates.add(file);
            }
            if (debug) {
                console.log(`[Search] Added ${fallback.length} fallback candidates, total: ${candidates.size}`);
            }
        }

        return candidates;
    }

    public async collectFilesystemCandidates(
        rootDir: string,
        shouldInclude: (relativePath: string) => boolean,
        options?: { maxCandidates?: number; timeoutMs?: number }
    ): Promise<Set<string>> {
        const candidates = new Set<string>();
        const maxCandidates = options?.maxCandidates ?? MAX_CANDIDATE_FILES;
        const timeoutMs = options?.timeoutMs ?? 0;
        const startedAt = Date.now();
        
        // If fileSystem is provided, use it. Otherwise, assume fs/promises (not ideal for tests)
        // But for consistency with SearchEngine, we should rely on IFileSystem.
        // If not provided, we can't scan filesystem reliably in a memory-fs environment.
        if (!this.fileSystem) {
            console.warn("[CandidateCollector] IFileSystem not provided, skipping filesystem scan");
            return candidates;
        }

        const stack: string[] = [rootDir];

        while (stack.length > 0) {
            if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
                break;
            }
            const current = stack.pop()!;
            let entries: string[];
            try {
                // IFileSystem.readDir returns string[] of names
                entries = await this.fileSystem.readDir(current);
            } catch {
                continue;
            }

            for (const name of entries) {
                const absPath = path.join(current, name);
                let stats;
                try {
                    stats = await this.fileSystem.stat(absPath);
                } catch {
                    continue;
                }

                if (stats.isDirectory()) {
                    stack.push(absPath);
                    continue;
                }

                const relativeToRoot = this.normalizeRelativePath(absPath, this.rootPath);
                
                if (!relativeToRoot) {
                    continue;
                }

                if (shouldInclude(relativeToRoot)) {
                    candidates.add(relativeToRoot);
                    if (candidates.size >= maxCandidates) {
                        return candidates;
                    }
                }
            }
        }

        return candidates;
    }

    private findByFilename(keywords: string[]): string[] {
        const allFiles = this.trigramIndex.listFiles();
        const matches: string[] = [];

        for (const filePath of allFiles) {
            const basename = path.basename(filePath).toLowerCase();
            const dirname = path.dirname(filePath).toLowerCase();
            const fullPath = filePath.toLowerCase();

            const allMatch = keywords.every(kw => {
                const lowerKw = kw.toLowerCase();
                return basename.includes(lowerKw) ||
                    dirname.includes(lowerKw) ||
                    fullPath.includes(lowerKw);
            });

            if (allMatch) {
                matches.push(filePath);
            }
        }

        return matches;
    }

    private async findBySymbolName(keywords: string[]): Promise<string[]> {
        if (!this.symbolIndex) {
            return [];
        }
        return this.symbolIndex.findFilesBySymbolName(keywords);
    }

    private normalizeRelativePath(filePath: string, basePath: string): string | null {
        const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath);
        const relative = path.relative(basePath, absolute);
        if (relative.startsWith('..')) {
            return null;
        }
        return relative.replace(/\\/g, '/') || path.basename(absolute);
    }
}
