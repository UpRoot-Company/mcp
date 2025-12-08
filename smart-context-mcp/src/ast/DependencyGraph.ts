import { SymbolIndex } from './SymbolIndex.js';
import { ModuleResolver } from './ModuleResolver.js';
import { ImportSymbol } from '../types.js';
import * as path from 'path';

export class DependencyGraph {
    private symbolIndex: SymbolIndex;
    private resolver: ModuleResolver;
    private rootPath: string;
    
    // Key: Relative Path (from root) - Normalized to forward slashes
    // Value: Set of Relative Paths - Normalized
    private outgoingEdges = new Map<string, Set<string>>();
    private incomingEdges = new Map<string, Set<string>>();

    constructor(rootPath: string, symbolIndex: SymbolIndex, resolver: ModuleResolver) {
        this.rootPath = rootPath;
        this.symbolIndex = symbolIndex;
        this.resolver = resolver;
    }

    public async build(): Promise<void> {
        this.outgoingEdges.clear();
        this.incomingEdges.clear();
        
        const symbolMap = await this.symbolIndex.getAllSymbols();
        
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
                    const resolved = this.resolver.resolve(contextPath, importSymbol.source);
                    
                    if (resolved) {
                        // Ensure resolved path is also within root (optional but good practice)
                        if (!resolved.startsWith(this.rootPath)) continue;

                        const resolvedRelative = path.relative(this.rootPath, resolved);
                        const normalizedTarget = this.normalizePath(resolvedRelative);
                        this.addEdge(normalizedSource, normalizedTarget);
                    }
                }
            }
        }
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
        
        if (this.outgoingEdges.size === 0 && this.incomingEdges.size === 0) {
            await this.build();
        }
        
        const map = direction === 'outgoing' ? this.outgoingEdges : this.incomingEdges;
        return Array.from(map.get(relPath) || []);
    }

    public async getTransitiveDependencies(
        filePath: string, 
        direction: 'incoming' | 'outgoing',
        maxDepth: number = 20
    ): Promise<string[]> {
        const startPath = this.getNormalizedRelativePath(filePath);

        if (this.outgoingEdges.size === 0 && this.incomingEdges.size === 0) {
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
