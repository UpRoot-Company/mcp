import { SymbolIndex } from './SymbolIndex.js';
import { ModuleResolver, ResolutionResult } from './ModuleResolver.js';
import { ImportSymbol, IndexStatus } from '../types.js';
import * as path from 'path';
import * as fs from 'fs';

export class DependencyGraph {
    private symbolIndex: SymbolIndex;
    private resolver: ModuleResolver;
    private rootPath: string;
    
    // Key: Relative Path (from root) - Normalized to forward slashes
    // Value: Set of Relative Paths - Normalized
    private outgoingEdges = new Map<string, Set<string>>();
    private incomingEdges = new Map<string, Set<string>>();
    private unresolvedImports = new Map<string, Set<string>>();
    private unresolvedDetails = new Map<string, Map<string, { error?: string; metadata?: Record<string, string> }>>();
    private lastRebuiltAt: number = 0;
    private needsRebuild = false;

    constructor(rootPath: string, symbolIndex: SymbolIndex, resolver: ModuleResolver) {
        this.rootPath = rootPath;
        this.symbolIndex = symbolIndex;
        this.resolver = resolver;
    }

    private recordUnresolved(source: string, specifier: string, resolution: ResolutionResult) {
        if (!this.unresolvedImports.has(source)) {
            this.unresolvedImports.set(source, new Set());
        }
        this.unresolvedImports.get(source)!.add(specifier);

        if (!this.unresolvedDetails.has(source)) {
            this.unresolvedDetails.set(source, new Map());
        }
        this.unresolvedDetails.get(source)!.set(specifier, {
            error: resolution.error,
            metadata: resolution.metadata
        });
    }

    public async build(): Promise<void> {
        this.outgoingEdges.clear();
        this.incomingEdges.clear();
        this.unresolvedImports.clear();
        this.unresolvedDetails.clear();
        
        const symbolMap = await this.symbolIndex.getAllSymbols();
        this.lastRebuiltAt = Date.now();
        
        for (const [relativePath, symbols] of symbolMap) {
            const contextPath = path.resolve(this.rootPath, relativePath);
            
            // Security check: Ensure context path is within root
            if (!contextPath.startsWith(this.rootPath)) {
                continue;
            }

            const normalizedSource = this.normalizePath(relativePath);
            
            for (const symbol of symbols) {
                if (symbol.type === 'import') {
                    const importSymbol = symbol as ImportSymbol;
                    const resolution = this.resolver.resolveDetailed(contextPath, importSymbol.source);
                    const resolved = resolution.resolvedPath;
                    
                    if (resolved) {
                        // Ensure resolved path is also within root (optional but good practice)
                        if (!resolved.startsWith(this.rootPath)) continue;

                        const resolvedRelative = path.relative(this.rootPath, resolved);
                        const normalizedTarget = this.normalizePath(resolvedRelative);
                        this.addEdge(normalizedSource, normalizedTarget);
                    } else {
                        this.recordUnresolved(normalizedSource, importSymbol.source, resolution);
                    }
                }
            }
        }
        this.needsRebuild = false;
    }
    
    private addEdge(from: string, to: string) {
        // from/to should already be normalized
        if (!this.outgoingEdges.has(from)) this.outgoingEdges.set(from, new Set());
        this.outgoingEdges.get(from)!.add(to);
        
        if (!this.incomingEdges.has(to)) this.incomingEdges.set(to, new Set());
        this.incomingEdges.get(to)!.add(from);
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
    
    public async getDependencies(filePath: string, direction: 'incoming' | 'outgoing'): Promise<string[]> {
        const relPath = this.getNormalizedRelativePath(filePath);
        
        if (this.needsRebuild || (this.outgoingEdges.size === 0 && this.incomingEdges.size === 0)) {
            await this.build();
        }
        
        const map = direction === 'outgoing' ? this.outgoingEdges : this.incomingEdges;
        return Array.from(map.get(relPath) || []);
    }

    public async getIndexStatus(): Promise<IndexStatus> {
        if (this.needsRebuild) {
            await this.build();
        }
        const symbolMap = await this.symbolIndex.getAllSymbols();
        const totalFiles = symbolMap.size;
        const observedFiles = new Set<string>();
        for (const file of symbolMap.keys()) {
            observedFiles.add(this.normalizePath(file));
        }
        for (const key of this.outgoingEdges.keys()) observedFiles.add(key);
        for (const key of this.incomingEdges.keys()) observedFiles.add(key);
        for (const key of this.unresolvedImports.keys()) observedFiles.add(key);
        
        let totalUnresolved = 0;
        const resolutionErrors: Array<{ filePath: string; importSpecifier: string; error: string; }> = [];
        
        for (const [file, unresolved] of this.unresolvedImports) {
            totalUnresolved += unresolved.size;
            for (const specifier of unresolved) {
                if (resolutionErrors.length < 50) { // Limit error details
                    const detail = this.unresolvedDetails.get(file)?.get(specifier);
                    const reasonParts = [];
                    if (detail?.error) reasonParts.push(detail.error);
                    if (detail?.metadata?.reason) reasonParts.push(detail.metadata.reason);
                    resolutionErrors.push({
                        filePath: file,
                        importSpecifier: specifier,
                        error: reasonParts.length > 0 ? reasonParts.join(' | ') : 'Module resolution failed'
                    });
                }
            }
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

        const perFile: IndexStatus['perFile'] = {};
        for (const file of observedFiles) {
            const unresolved = Array.from(this.unresolvedImports.get(file) || []);
            perFile[file] = {
                resolved: unresolved.length === 0,
                unresolvedImports: unresolved,
                incomingDependenciesCount: this.incomingEdges.get(file)?.size || 0,
                outgoingDependenciesCount: this.outgoingEdges.get(file)?.size || 0
            };
        }

        return {
            global: {
                totalFiles,
                indexedFiles: observedFiles.size,
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
        this.removeFileFromGraph(relPath);
        this.needsRebuild = true;
    }

    public async invalidateDirectory(dirPath: string): Promise<void> {
        const absPath = path.isAbsolute(dirPath) ? dirPath : path.join(this.rootPath, dirPath);
        this.symbolIndex.invalidateDirectory(absPath);
        const relPath = this.getNormalizedRelativePath(absPath);
        if (!relPath) {
            this.outgoingEdges.clear();
            this.incomingEdges.clear();
            this.unresolvedImports.clear();
            this.unresolvedDetails.clear();
            this.needsRebuild = true;
            return;
        }
        this.removeDirectoryFromGraph(relPath);
        this.needsRebuild = true;
    }

    private removeFileFromGraph(relPath: string) {
        this.outgoingEdges.delete(relPath);
        this.incomingEdges.delete(relPath);
        this.unresolvedImports.delete(relPath);
        this.unresolvedDetails.delete(relPath);

        for (const set of this.outgoingEdges.values()) {
            set.delete(relPath);
        }
        for (const set of this.incomingEdges.values()) {
            set.delete(relPath);
        }
    }

    private removeDirectoryFromGraph(relDir: string) {
        const normalizedDir = relDir.endsWith('/') ? relDir : `${relDir}/`;
        const match = (value: string) => value === relDir || value.startsWith(normalizedDir);

        for (const key of Array.from(this.outgoingEdges.keys())) {
            if (match(key)) {
                this.outgoingEdges.delete(key);
            }
        }
        for (const key of Array.from(this.incomingEdges.keys())) {
            if (match(key)) {
                this.incomingEdges.delete(key);
            }
        }
        for (const key of Array.from(this.unresolvedImports.keys())) {
            if (match(key)) {
                this.unresolvedImports.delete(key);
            }
        }
        for (const key of Array.from(this.unresolvedDetails.keys())) {
            if (match(key)) {
                this.unresolvedDetails.delete(key);
            }
        }

        for (const set of this.outgoingEdges.values()) {
            for (const target of Array.from(set)) {
                if (match(target)) {
                    set.delete(target);
                }
            }
        }
        for (const set of this.incomingEdges.values()) {
            for (const target of Array.from(set)) {
                if (match(target)) {
                    set.delete(target);
                }
            }
        }
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

    public async getTransitiveDependencies(
        filePath: string, 
        direction: 'incoming' | 'outgoing',
        maxDepth: number = 20
    ): Promise<string[]> {
        const startPath = this.getNormalizedRelativePath(filePath);

        if (this.needsRebuild || (this.outgoingEdges.size === 0 && this.incomingEdges.size === 0)) {
            await this.build();
        }

        const visited = new Set<string>();
        const queue: { path: string; depth: number }[] = [{ path: startPath, depth: 0 }];
        const result: string[] = [];
        
        visited.add(startPath);

        while (queue.length > 0) {
            const { path: currentPath, depth } = queue.shift()!;

            if (depth >= maxDepth) continue;
            
            const map = direction === 'outgoing' ? this.outgoingEdges : this.incomingEdges;
            const deps = map.get(currentPath);

            if (deps) {
                for (const dep of deps) {
                    if (!visited.has(dep)) {
                        visited.add(dep);
                        result.push(dep);
                        queue.push({ path: dep, depth: depth + 1 });
                    }
                }
            }
        }

        return result;
    }
}
