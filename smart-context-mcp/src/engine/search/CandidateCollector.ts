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

    public async collectHybridCandidates(keywords: string[]): Promise<Set<string>> {
        const candidates = new Set<string>();

        // Source 1: Trigram index
        const trigramQuery = keywords.join(' ');
        const trigramResults = await this.trigramIndex.search(trigramQuery, MAX_CANDIDATE_FILES * 2);
        for (const result of trigramResults) {
            candidates.add(result.filePath);
        }
        console.log(`[Search] Trigram candidates: ${trigramResults.length}`);

        // Source 2: Filename matching
        const filenameMatches = this.findByFilename(keywords);
        for (const path of filenameMatches) {
            candidates.add(path);
        }
        console.log(`[Search] Filename matches: ${filenameMatches.length}`);

        // Source 3: Symbol index
        if (this.symbolIndex) {
            const symbolMatches = await this.findBySymbolName(keywords);
            for (const path of symbolMatches) {
                candidates.add(path);
            }
            console.log(`[Search] Symbol matches: ${symbolMatches.length}`);
        }

        // Source 4: Fallback
        if (candidates.size < 20) {
            const allFiles = this.trigramIndex.listFiles();
            const fallback = allFiles.slice(0, MAX_CANDIDATE_FILES * 3);
            for (const file of fallback) {
                candidates.add(file);
            }
            console.log(`[Search] Added ${fallback.length} fallback candidates, total: ${candidates.size}`);
        }

        return candidates;
    }

    public async collectFilesystemCandidates(
        rootDir: string,
        shouldInclude: (relativePath: string) => boolean
    ): Promise<Set<string>> {
        const candidates = new Set<string>();
        
        // If fileSystem is provided, use it. Otherwise, assume fs/promises (not ideal for tests)
        // But for consistency with SearchEngine, we should rely on IFileSystem.
        // If not provided, we can't scan filesystem reliably in a memory-fs environment.
        if (!this.fileSystem) {
            console.warn("[CandidateCollector] IFileSystem not provided, skipping filesystem scan");
            return candidates;
        }

        const stack: string[] = [rootDir];

        while (stack.length > 0) {
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
        const matches = new Set<string>();
        if (!this.symbolIndex) {
            return [];
        }

        const allSymbols = await this.symbolIndex.getAllSymbols();
        for (const [filePath, symbols] of allSymbols.entries()) {
            for (const symbol of symbols) {
                const lowerSymbol = symbol.name.toLowerCase();
                for (const keyword of keywords) {
                    if (lowerSymbol.includes(keyword.toLowerCase())) {
                        matches.add(filePath);
                        break;
                    }
                }
            }
        }

        return Array.from(matches);
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
