import * as path from 'path';
import * as fs from 'fs';
import { SymbolIndex } from './SymbolIndex.js';
import { ModuleResolver, ResolutionResult } from './ModuleResolver.js';
import { ImportSymbol, IndexStatus, SymbolInfo } from '../types.js';
import { IndexDatabase } from '../indexing/IndexDatabase.js';
import { ImportExtractor } from './ImportExtractor.js';
import { ExportExtractor } from './ExportExtractor.js';
import { ReverseImportIndex } from './ReverseImportIndex.js';

export interface DependencyEdge {
    from: string;
    to: string;
    type: string;
    what?: string;
    line?: number;
}

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
    private loggingEnabled = true;

    private importExtractor: ImportExtractor;
    private exportExtractor: ExportExtractor;
    private reverseIndex: ReverseImportIndex;

    constructor(rootPath: string, symbolIndex: SymbolIndex, resolver: ModuleResolver, db?: IndexDatabase) {
        this.rootPath = rootPath;
        this.symbolIndex = symbolIndex;
        this.resolver = resolver;
        this.db = db ?? this.symbolIndex.getDatabase();

        this.importExtractor = new ImportExtractor(this.rootPath);
        this.exportExtractor = new ExportExtractor(this.rootPath);
        this.reverseIndex = new ReverseImportIndex();
    }

    public setLoggingEnabled(enabled: boolean): void {
        this.loggingEnabled = enabled;
    }

    private log(level: 'log' | 'info' | 'warn' | 'error', ...args: any[]): void {
        if (!this.loggingEnabled) {
            return;
        }
        console[level](...args);
    }

    public isBuilt(): boolean {
        return this.lastRebuiltAt > 0;
    }

    public async ensureBuilt(): Promise<void> {
        if (this.isBuilt()) {
            return;
        }
        await this.build();
    }

    public async restoreEdges(filePath: string, edges: Array<{ from: string; to: string; type: string; what: string; line: number }>): Promise<void> {
        const relPath = this.getNormalizedRelativePath(filePath);
        const outgoing: EdgeMetadata[] = edges.map(edge => ({
            targetPath: this.getNormalizedRelativePath(edge.to),
            type: edge.type,
            metadata: { what: edge.what, line: edge.line }
        }));

        const stats = await fs.promises.stat(filePath).catch(() => undefined);
        const lastModified = stats?.mtimeMs ?? Date.now();

        this.db.replaceDependencies({
            relativePath: relPath,
            lastModified,
            outgoing,
            unresolved: []
        });
        this.lastRebuiltAt = Date.now();
    }

    public async build(): Promise<void> {
        const symbolMap = await this.symbolIndex.getAllSymbols();
        for (const [pathOrRel, _] of symbolMap) {
            const absPath = path.isAbsolute(pathOrRel) ? pathOrRel : path.join(this.rootPath, pathOrRel);
            await this.updateFileDependencies(absPath);
        }
        this.lastRebuiltAt = Date.now();
    }

    public async updateFileDependencies(filePath: string): Promise<void> {
        this.log('log', `[DependencyGraph] Updating dependencies for ${filePath}`);
        
        const relPath = this.getNormalizedRelativePath(filePath);
        const stats = await fs.promises.stat(filePath).catch(() => undefined);
        const lastModified = stats?.mtimeMs ?? Date.now();

        // Extract imports using AST parsing
        const imports = await this.importExtractor.extractImports(filePath);
        
        this.log('log', `[DependencyGraph] Found ${imports.length} imports in ${filePath}`);
        
        const outgoing: EdgeMetadata[] = [];
        const unresolved: UnresolvedMetadata[] = [];

        // Convert imports to dependency edges
        for (const imp of imports) {
            const resolution = this.resolver.resolveDetailed(filePath, imp.specifier);
            const isCore = resolution.metadata?.core === 'true';
            const isExternal = resolution.metadata?.external === 'true';
            if (isCore || isExternal) {
                continue;
            }

            if (resolution.resolvedPath) {
                const targetRelative = this.getNormalizedRelativePath(resolution.resolvedPath);
                outgoing.push({
                    targetPath: targetRelative,
                    type: imp.importType,
                    metadata: {
                        what: imp.what.join(', '),
                        line: imp.line,
                        specifier: imp.specifier,
                        ...resolution.metadata
                    }
                });
            } else {
                unresolved.push({
                    specifier: imp.specifier,
                    error: resolution.error ?? 'Module resolution failed',
                    metadata: {
                        what: imp.what.join(', '),
                        line: imp.line,
                        ...resolution.metadata
                    }
                });
            }
        }
        
        // Store in database
        this.db.replaceDependencies({
            relativePath: relPath,
            lastModified,
            outgoing,
            unresolved
        });
        
        // Update reverse index
        this.reverseIndex.removeImporter(relPath);
        for (const imp of imports) {
            if (!imp.resolvedPath) continue;
            const targetRelative = this.getNormalizedRelativePath(imp.resolvedPath);
            this.reverseIndex.addImport(relPath, targetRelative);
        }
        this.lastRebuiltAt = Date.now();
    }

    public async getImporters(targetFile: string): Promise<DependencyEdge[]> {
        return this.getDependencies(targetFile, 'upstream');
    }

    public async getDependencies(
        filePath: string, 
        direction: 'upstream' | 'downstream' | 'both' = 'both'
    ): Promise<DependencyEdge[]> {
        const relPath = this.getNormalizedRelativePath(filePath);
        const edges: DependencyEdge[] = [];
        const wantsAbsolute = path.isAbsolute(filePath);

        const formatPathValue = (p: string): string => {
            const normalized = this.normalizePath(p);
            if (!wantsAbsolute || path.isAbsolute(normalized) || !normalized) {
                return normalized;
            }
            return this.normalizePath(path.join(this.rootPath, normalized));
        };

        // Downstream (outgoing) - files this file imports
        if (direction === 'downstream' || direction === 'both') {
            const records = this.db.getDependencies(relPath, 'outgoing');
            edges.push(...records.map(r => ({
                from: formatPathValue(r.source),
                to: formatPathValue(r.target),
                type: r.type,
                what: (r.metadata?.what as string) || undefined,
                line: (r.metadata?.line as number) || undefined
            })));
        }

        // Upstream (incoming) - files that import this file
        if (direction === 'upstream' || direction === 'both') {
            const records = this.db.getDependencies(relPath, 'incoming');
            edges.push(...records.map(r => ({
                from: formatPathValue(r.source),
                to: formatPathValue(r.target),
                type: r.type,
                what: (r.metadata?.what as string) || undefined,
                line: (r.metadata?.line as number) || undefined
            })));
        }

        return edges;
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
            
            for (const neighborRecord of neighbors) {
                const nextPath = direction === 'outgoing' ? neighborRecord.target : neighborRecord.source;
                const normalized = this.normalizePath(nextPath);
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

    public async rebuildUnresolved(): Promise<void> {
        if (!this.db) {
            this.log('warn', '[DependencyGraph] IndexDatabase not available; skipping unresolved rebuild');
            return;
        }

        this.log('info', '[DependencyGraph] Rebuilding unresolved dependencies...');
        try {
            const unresolved = this.db.listUnresolved();
            const filePathSet = new Set<string>();

            for (const entry of unresolved) {
                filePathSet.add(entry.filePath);
            }

            let rebuiltCount = 0;
            for (const relativePath of filePathSet) {
                const absPath = path.isAbsolute(relativePath)
                    ? relativePath
                    : path.join(this.rootPath, relativePath);
                try {
                    await this.updateFileDependencies(absPath);
                    rebuiltCount++;
                } catch (error) {
                    this.log('warn', `[DependencyGraph] Failed to rebuild dependencies for ${relativePath}:`, error);
                }
            }

            this.log('info', `[DependencyGraph] Rebuilt dependencies for ${rebuiltCount} files with previously unresolved imports`);
        } catch (error) {
            this.log('error', '[DependencyGraph] Error rebuilding unresolved dependencies:', error);
        }
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
        const isCore = resolution.metadata?.core === 'true';
        const isExternal = resolution.metadata?.external === 'true';
        if (isCore || isExternal) {
            return;
        }

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
