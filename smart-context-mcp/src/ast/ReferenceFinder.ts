import * as path from 'path';
import * as fs from 'fs';
import { DependencyGraph } from './DependencyGraph.js';
import { SymbolIndex } from './SymbolIndex.js';
import { SkeletonGenerator } from './SkeletonGenerator.js';
import { ModuleResolver } from './ModuleResolver.js';
import { ImportSymbol, ExportSymbol, SymbolInfo } from '../types.js';

export interface ReferenceResult {
    filePath: string;
    line: number;
    text: string;
    range: { startLine: number; endLine: number; startByte: number; endByte: number };
}

export class ReferenceFinder {
    // Request-scoped cache to avoid re-parsing the same file multiple times during one search
    private symbolCache = new Map<string, SymbolInfo[]>();

    constructor(
        private rootPath: string,
        private graph: DependencyGraph,
        private index: SymbolIndex,
        private generator: SkeletonGenerator,
        private resolver: ModuleResolver
    ) {}

    public async findReferences(symbolName: string, definitionFilePath: string): Promise<ReferenceResult[]> {
        this.symbolCache.clear();
        const results: ReferenceResult[] = [];
        
        const searchFiles = new Set<string>();
        const normalizedDefPath = path.resolve(definitionFilePath);
        searchFiles.add(normalizedDefPath);
        
        const incoming = await this.graph.getDependencies(normalizedDefPath, 'incoming');
        for (const f of incoming) {
            searchFiles.add(path.resolve(this.rootPath, f));
        }

        // Check if symbolName is the default export
        let isDefaultExport = false;
        try {
            if (fs.existsSync(normalizedDefPath)) {
                const defContent = fs.readFileSync(normalizedDefPath, 'utf-8');
                const defSymbols = await this.generator.generateStructureJson(normalizedDefPath, defContent);
                const defaultExport = defSymbols.find((s: any) => s.type === 'export' && (s as ExportSymbol).exportKind === 'default');
                
                if (defaultExport) {
                    if (defaultExport.name === symbolName || symbolName === 'default') {
                        isDefaultExport = true;
                    }
                }
            }
        } catch (e) { /* ignore */ }

        for (const file of searchFiles) {
            try {
                if (!fs.existsSync(file)) continue;
                
                const content = fs.readFileSync(file, 'utf-8');
                const targetNames = await this.resolveLocalNames(file, normalizedDefPath, symbolName, content, isDefaultExport);
                
                if (targetNames.length > 0) {
                    const identifiers = await this.generator.findIdentifiers(file, content, targetNames);
                    for (const id of identifiers) {
                        results.push({
                            filePath: path.relative(this.rootPath, file),
                            line: id.range.startLine,
                            text: id.name,
                            range: id.range
                        });
                    }
                }
            } catch (error) {
                // Ignore
            }
        }
        
        return results;
    }

    private async resolveLocalNames(currentFile: string, definitionFile: string, exportedName: string, content: string, isDefaultExport: boolean): Promise<string[]> {
        if (currentFile === definitionFile) return [exportedName];

        const names: string[] = [];
        
        let symbols = this.symbolCache.get(currentFile);
        if (!symbols) {
            symbols = await this.generator.generateStructureJson(currentFile, content);
            this.symbolCache.set(currentFile, symbols);
        }
        
        for (const sym of symbols) {
            if (sym.type === 'import') {
                const importSym = sym as ImportSymbol;
                const resolvedSource = this.resolver.resolve(currentFile, importSym.source);
                
                if (resolvedSource && path.relative(resolvedSource, definitionFile) === '') {
                    if (importSym.importKind === 'named' && importSym.imports) {
                        const match = importSym.imports.find((i: any) => i.name === exportedName);
                        if (match) {
                            names.push(match.alias || match.name);
                        }
                    } else if (importSym.importKind === 'default') {
                        if (isDefaultExport) {
                            if (importSym.alias) names.push(importSym.alias);
                        }
                    } else if (importSym.importKind === 'namespace') {
                        if (importSym.alias) {
                            // Usage: ns.exportedName OR ns.default
                            if (isDefaultExport) {
                                names.push('default'); 
                            } else {
                                names.push(exportedName);
                            }
                        }
                    }
                }
            }
        }
        
        return names;
    }
}
