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

        let targetDefinition: SymbolInfo | undefined;
        let defaultExportNames: string[] = [];
        try {
            const defSymbols = await this.index.getSymbolsForFile(normalizedDefPath);
            targetDefinition = this.findMatchingSymbol(defSymbols, symbolName);
            defaultExportNames = this.getDefaultExportNames(defSymbols);
        } catch (e) {
            console.error(`Error getting symbols for definition file ${normalizedDefPath}:`, e);
            return [];
        }

        if (!targetDefinition) {
            // If we can't find the definition symbol, we can't find references
            return [];
        }

        const treatAsDefaultExport = symbolName === 'default' || defaultExportNames.includes(symbolName);

        for (const file of searchFiles) {
            try {
                if (!fs.existsSync(file)) continue;
                
                const content = fs.readFileSync(file, 'utf-8');
                const targetNames = await this.resolveLocalNames(file, normalizedDefPath, symbolName, content, treatAsDefaultExport);
                if (targetNames.length === 0) {
                    continue;
                }

                const identifiers = await this.generator.findIdentifiers(file, content, targetNames);
                for (const id of identifiers) {
                    if (file === normalizedDefPath && this.isDefinitionRange(id.range, targetDefinition)) {
                        continue;
                    }
                    results.push({
                        filePath: path.relative(this.rootPath, file),
                        line: id.range.startLine + 1,
                        text: id.name,
                        range: {
                            startLine: id.range.startLine + 1,
                            endLine: id.range.endLine + 1,
                            startByte: id.range.startByte,
                            endByte: id.range.endByte
                        }
                    });
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
                
                if (resolvedSource && path.normalize(resolvedSource) === path.normalize(definitionFile)) {
                    if (importSym.importKind === 'named' && importSym.imports) {
                        for (const imported of importSym.imports) {
                            // If the imported symbol's remote name (or its local alias) matches our exportedName
                            if (imported.name === exportedName || imported.alias === exportedName) {
                                // Add the local name of the imported symbol (which could be the original name or the alias)
                                names.push(imported.alias || imported.name);
                            }
                        }
                    } else if (importSym.importKind === 'default' && isDefaultExport) {
                        // If it's a default import and the definition is a default export
                        names.push(importSym.name);
                    } else if (importSym.importKind === 'namespace') {
                        if (isDefaultExport) {
                            names.push('default');
                        } else {
                            names.push(exportedName);
                        }
                    }
                }
            }
        }

        return names;
    }

    private findMatchingSymbol(symbols: SymbolInfo[], symbolName: string): SymbolInfo | undefined {
        const definitionMatch = symbols.find(symbol => symbol.type !== 'import' && symbol.type !== 'export' && symbol.name === symbolName);
        if (definitionMatch) {
            return definitionMatch;
        }

        for (const symbol of symbols) {
            if (symbol.type !== 'export') {
                continue;
            }
            if (symbol.exportKind === 'default') {
                if (symbol.name === symbolName || symbolName === 'default') {
                    return symbol;
                }
            } else if (symbol.exportKind === 'named' && symbol.exports) {
                const match = symbol.exports.find(exp => exp.name === symbolName || exp.alias === symbolName);
                if (match) {
                    return symbol;
                }
            }
        }
        return undefined;
    }

    private isDefinitionRange(range: { startByte: number; endByte: number }, symbol: SymbolInfo | undefined): boolean {
        if (!symbol || !symbol.range) return false;
        const { startByte, endByte } = symbol.range;
        return typeof startByte === 'number' && typeof endByte === 'number' &&
            range.startByte >= startByte && range.endByte <= endByte;
    }

    private getDefaultExportNames(symbols: SymbolInfo[]): string[] {
        const names: string[] = [];
        for (const symbol of symbols) {
            if (symbol.type === 'export' && symbol.exportKind === 'default') {
                names.push(symbol.name || 'default');
            }
        }
        return names;
    }
}
