import * as fs from 'fs';
import { SymbolIndex, SymbolSearchResult } from '../ast/SymbolIndex.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { SymbolInfo, GhostInterface } from '../types.js';
import { GhostInterfaceBuilder } from './GhostInterfaceBuilder.js';

export class FallbackResolver {
    constructor(
        private symbolIndex: SymbolIndex,
        private skeletonGenerator: SkeletonGenerator,
        private ghostBuilder?: GhostInterfaceBuilder
    ) {}

    /**
     * Tier 4: Ghost Interface Archeology
     */
    async reconstructGhostInterface(symbolName: string): Promise<GhostInterface | null> {
        if (!this.ghostBuilder) return null;
        return this.ghostBuilder.reconstruct(symbolName);
    }

    /**
     * Tier 2: Direct AST parsing for recent edits
     */
    async parseFileForSymbol(symbolName: string): Promise<SymbolSearchResult[]> {
        const recentFiles = this.symbolIndex.getRecentlyModified(30000); // 30s window
        const results: SymbolSearchResult[] = [];

        for (const filePath of recentFiles) {
            if (!fs.existsSync(filePath)) continue;
            
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const symbols = await this.skeletonGenerator.generateStructureJson(filePath, content);
                
                const matches = symbols.filter(s => s.name === symbolName);
                for (const symbol of matches) {
                    results.push({ filePath, symbol });
                }
            } catch (error) {
                console.warn(`Failed to parse ${filePath} in FallbackResolver:`, error);
            }
        }

        return results;
    }

    /**
     * Tier 3: Regex heuristic for edge cases
     */
    async regexSymbolSearch(symbolName: string): Promise<SymbolSearchResult[]> {
        const patterns = [
            new RegExp(`class\\s+${symbolName}\\s*[{<]`, 'g'),
            new RegExp(`function\\s+${symbolName}\\s*[(<]`, 'g'),
            new RegExp(`const\\s+${symbolName}\\s*=`, 'g'),
            new RegExp(`let\\s+${symbolName}\\s*=`, 'g'),
            new RegExp(`export\\s+.*${symbolName}`, 'g'),
            new RegExp(`interface\\s+${symbolName}\\s*[{<]`, 'g'),
            new RegExp(`type\\s+${symbolName}\\s*=`, 'g'),
        ];

        const recentFiles = this.symbolIndex.getRecentlyModified(60000); // 60s window
        const results: SymbolSearchResult[] = [];

        for (const filePath of recentFiles) {
             if (!fs.existsSync(filePath)) continue;
             
             try {
                 const content = fs.readFileSync(filePath, 'utf-8');
                 for (const pattern of patterns) {
                     if (pattern.test(content)) {
                         const symbol: SymbolInfo = {
                             name: symbolName,
                             type: 'variable', 
                             range: { startLine: 0, endLine: 0, startByte: 0, endByte: 0 }, 
                             content: ''
                         };
                         results.push({ filePath, symbol });
                         break; 
                     }
                 }
             } catch (error) {
                 console.warn(`Failed to regex search ${filePath}:`, error);
             }
        }
        
        return results;
    }
}
