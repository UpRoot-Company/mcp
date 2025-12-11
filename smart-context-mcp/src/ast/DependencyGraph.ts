import * as path from 'path';
import * as fs from 'fs';
import { SymbolIndex } from './SymbolIndex.js';
import { ModuleResolver, ResolutionResult } from './ModuleResolver.js';
import { ImportSymbol, IndexStatus, SymbolInfo } from '../types.js';
import { IndexDatabase } from '../indexing/IndexDatabase.js';

interface EdgeMetadata {
    targetPath?: string;
    type: string;
    weight?: number;
    metadata?: Record<string, unknown>;
}

interface UnresolvedMetadata {
    specifier: string;
    error?: string;
    metadata?: Record<string, unknown>;
}

export class DependencyGraph {
    private readonly rootPath: string;
    private readonly symbolIndex: SymbolIndex;
    private readonly resolver: ModuleResolver;
    private readonly db: IndexDatabase;
    private lastRebuiltAt = 0;

    constructor(rootPath: string, symbolIndex: SymbolIndex, resolver: ModuleResolver, db?: IndexDatabase) {
        this.rootPath = rootPath;
        this.symbolIndex = symbolIndex;
        this.resolver = resolver;
        this.db = db ?? this.symbolIndex.getDatabase();
    }

    public async build(): Promise<void> {
        const symbolMap = await this.symbolIndex.getAllSymbols();
        for (const [relativePath, symbols] of symbolMap) {
            await this.updateDependenciesForSymbols(relativePath, symbols);
        }
        this.lastRebuiltAt = Date.now();
    }

    public async updateFileDependencies(filePath: string, symbols?: SymbolInfo[]): Promise<void> {
        const relPath = this.getNormalizedRelativePath(filePath);
        const data = symbols ?? await this.symbolIndex.getSymbolsForFile(filePath);
        const stats = await fs.promises.stat(filePath).catch(() => undefined);
        const lastModified = stats?.mtimeMs ?? Date.now();
        await this.updateDependenciesForSymbols(relPath, data, lastModified);
    }

    public async getDependencies(filePath: string, direction: 'incoming' | 'outgoing'): Promise<string[]> {
        const relPath = this.getNormalizedRelativePath(filePath);
        const deps = this.db.getDependencies(relPath, direction);
        return deps.map(dep => this.normalizePath(dep));
    }

    public async getTransitiveDependencies(filePath: string, direction: 'incoming' | 'outgoing', maxDepth: number = 20): Promise<string[]> {
        const start = this.getNormalizedRelativePath(filePath);
        const visited = new Set<string>([start]);
        const queue: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }];
        const results: string[] = [];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current.depth >= maxDepth) continue;
            const neighbors = this.db.getDependencies(current.path, direction);
            for (const neighbor of neighbors) {
                const normalized = this.normalizePath(neighbor);
                if (visited.has(normalized)) continue;
                visited.add(normalized);
                results.push(normalized);
                queue.push({ path: normalized, depth: current.depth + 1 });
            }
        }
        return results;
    }

    public async getIndexStatus(): Promise<IndexStatus> {
        const files = this.db.listFiles();
        const totalFiles = files.length;
        const unresolvedEntries = this.db.listUnresolved();
        const totalUnresolved = unresolvedEntries.length;
        const resolutionErrors = unresolvedEntries.slice(0, 50).map(entry => ({
            filePath: entry.filePath,
            importSpecifier: entry.specifier,
            error: entry.error ?? 'Module resolution failed'
        }));

        const perFile: IndexStatus['perFile'] = {};
        for (const file of files) {
            const unresolved = this.db.listUnresolvedForFile(file.path).map(u => u.specifier);
            perFile[file.path] = {
                resolved: unresolved.length === 0,
                unresolvedImports: unresolved,
                incomingDependenciesCount: this.db.countDependencies(file.path, 'incoming'),
                outgoingDependenciesCount: this.db.countDependencies(file.path, 'outgoing')
            };
        }

        const unresolvedRatio = totalFiles === 0 ? 0 : totalUnresolved / totalFiles;
        let confidence: 'high' | 'medium' | 'low';
        if (unresolvedRatio === 0) {
            confidence = 'high';
        } else if (unresolvedRatio < 0.25) {
            confidence = 'medium';
        } else {
            confidence = 'low';
        }

        const ageMs = Date.now() - this.lastRebuiltAt;
        if (ageMs > 1000 * 60 * 60) {
            confidence = confidence === 'high' ? 'medium' : 'low';
        }

        return {
            global: {
                totalFiles,
                indexedFiles: files.length,
                unresolvedImports: totalUnresolved,
                resolutionErrors,
                lastRebuiltAt: new Date(this.lastRebuiltAt || Date.now()).toISOString(),
                confidence,
                isMonorepo: this.detectMonorepo()
            },
            perFile
        };
    }

    public async invalidateFile(filePath: string): Promise<void> {
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        this.symbolIndex.invalidateFile(absPath);
        const relPath = this.getNormalizedRelativePath(absPath);
        this.clearDependencies(relPath);
    }

    public async invalidateDirectory(dirPath: string): Promise<void> {
        const absPath = path.isAbsolute(dirPath) ? dirPath : path.join(this.rootPath, dirPath);
        this.symbolIndex.invalidateDirectory(absPath);
        const relPath = this.getNormalizedRelativePath(absPath);
        if (!relPath) {
            this.db.deleteFilesByPrefix('');
            return;
        }
        this.db.deleteFilesByPrefix(relPath);
    }

    public async removeFile(filePath: string): Promise<void> {
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        this.symbolIndex.dropFileFromIndex(absPath);
    }

    public async removeDirectory(dirPath: string): Promise<void> {
        const absPath = path.isAbsolute(dirPath) ? dirPath : path.join(this.rootPath, dirPath);
        this.symbolIndex.dropDirectoryFromIndex(absPath);
    }

    private clearDependencies(relativePath: string): void {
        this.db.clearDependencies(relativePath);
    }

    private async updateDependenciesForSymbols(relativePath: string, symbols: SymbolInfo[], lastModified?: number): Promise<void> {
        const normalized = this.normalizePath(relativePath);
        const outgoing: EdgeMetadata[] = [];
        const unresolved: UnresolvedMetadata[] = [];
        const absPath = path.resolve(this.rootPath, normalized);

        for (const symbol of symbols) {
            if (symbol.type !== 'import') continue;
            const importSymbol = symbol as ImportSymbol;
            const resolution = this.resolver.resolveDetailed(absPath, importSymbol.source);
            this.handleResolution(normalized, importSymbol, resolution, outgoing, unresolved);
        }

        const finalMtime = typeof lastModified === 'number'
            ? lastModified
            : this.db.getFile(normalized)?.last_modified ?? Date.now();

        this.db.replaceDependencies({
            relativePath: normalized,
            lastModified: finalMtime,
            outgoing,
            unresolved
        });
        this.lastRebuiltAt = Date.now();
    }

    private handleResolution(
        sourcePath: string,
        importSymbol: ImportSymbol,
        resolution: ResolutionResult,
        outgoing: EdgeMetadata[],
        unresolved: UnresolvedMetadata[]
    ): void {
        const resolved = resolution.resolvedPath;
        if (resolved && resolved.startsWith(this.rootPath)) {
            const targetRelative = path.relative(this.rootPath, resolved);
            outgoing.push({
                targetPath: this.normalizePath(targetRelative),
                type: importSymbol.importKind,
                metadata: resolution.metadata
            });
        } else {
            unresolved.push({
                specifier: importSymbol.source,
                error: resolution.error,
                metadata: resolution.metadata
            });
        }
    }

    private normalizePath(p: string): string {
        return p.replace(/\\/g, '/');
    }

    private getNormalizedRelativePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return this.normalizePath(path.relative(this.rootPath, filePath));
        }
        return this.normalizePath(filePath);
    }

    private detectMonorepo(): boolean {
        const indicatorFiles = ['lerna.json', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json'];
        if (indicatorFiles.some(file => fs.existsSync(path.join(this.rootPath, file)))) {
            return true;
        }

        const candidateDirs = ['packages', 'apps', 'services', 'libs'];
        for (const dir of candidateDirs) {
            const rootDir = path.join(this.rootPath, dir);
            if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) continue;
            const subdirs = fs.readdirSync(rootDir).filter(entry => {
                const full = path.join(rootDir, entry);
                try {
                    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'package.json'));
                } catch {
                    return false;
                }
            });
            if (subdirs.length > 0) {
                return true;
            }
        }
        return false;
    }
}
