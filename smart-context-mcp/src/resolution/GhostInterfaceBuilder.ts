import { SearchEngine } from "../engine/Search.js";
import { CallSiteAnalyzer } from "../ast/analysis/CallSiteAnalyzer.js";
import { AstManager } from "../ast/AstManager.js";
import { IFileSystem } from "../platform/FileSystem.js";
import { GhostInterface, GhostMethodInfo, CallSiteInfo } from "../types.js";
import * as path from "path";
import { Query } from 'web-tree-sitter';

export class GhostInterfaceBuilder {
    constructor(
        private searchEngine: SearchEngine,
        private callSiteAnalyzer: CallSiteAnalyzer,
        private astManager: AstManager,
        private fileSystem: IFileSystem,
        private rootPath: string
    ) {}

    public async reconstruct(symbolName: string): Promise<GhostInterface | null> {
        // 1. Find all occurrences of symbolName
        const searchResults = await this.searchEngine.scout({
            query: symbolName,
            wordBoundary: true,
            groupByFile: true
        });

        if (searchResults.length === 0) return null;

        const callSites: (CallSiteInfo & { filePath: string })[] = [];
        const sourceFiles = new Set<string>();

        // 2. Parse and analyze each file
        for (const result of searchResults) {
            const absPath = path.isAbsolute(result.filePath) 
                ? result.filePath 
                : path.join(this.rootPath, result.filePath);
            
            try {
                const content = await this.fileSystem.readFile(absPath);
                const langId = this.astManager.getLanguageId(absPath);
                const doc = await this.astManager.parseFile(absPath, content);
                
                if (!doc) continue;

                const lang = await this.astManager.getLanguageForFile(absPath);
                if (!lang) continue;

                const fileCallSites = this.callSiteAnalyzer.extractCallSites(doc.rootNode, lang, langId);
                
                // Heuristic: Find variables that are instances of symbolName
                const instanceVars = this.findInstances(doc.rootNode, symbolName, langId, lang);

                // Filter calls that specifically target our symbolName or its instances
                const targetingCalls = fileCallSites.filter(call => 
                    call.calleeObject === symbolName || 
                    call.calleeName === symbolName ||
                    (call.calleeObject && instanceVars.has(call.calleeObject))
                );

                if (targetingCalls.length > 0) {
                    for (const call of targetingCalls) {
                        callSites.push({ ...call, filePath: result.filePath });
                    }
                    sourceFiles.add(result.filePath);
                }
            } catch (error) {
                console.error(`Failed to analyze ${absPath} for ghost reconstruction:`, error);
            }
        }

        if (callSites.length === 0) return null;

        // 3. Aggregate and infer
        const methods = this.inferMethods(callSites);
        const confidence = this.computeConfidence(callSites.length, sourceFiles.size);

        return {
            name: symbolName,
            methods,
            confidence,
            usageCount: callSites.length,
            sourceFiles: Array.from(sourceFiles)
        };
    }

    private findInstances(rootNode: any, symbolName: string, langId: string, lang: any): Set<string> {
        const instances = new Set<string>();
        
        // Very basic heuristic for TS/JS: look for const/let/var x = new SymbolName()
        if (['typescript', 'tsx', 'javascript'].includes(langId) && this.astManager.supportsQueries()) {
            try {
                const query = new Query(lang, `
                    (variable_declarator
                        name: (identifier) @var_name
                        value: (new_expression
                            constructor: (identifier) @class_name (#eq? @class_name "${symbolName}")))
                `);

                const matches = query.matches(rootNode);
                for (const match of matches) {
                    const node = match.captures.find((c: any) => c.name === 'var_name')?.node;
                    if (node) instances.add(node.text);
                }
            } catch (e) {
                // Ignore query errors
            }
        }

        return instances;
    }

    private inferMethods(callSites: (CallSiteInfo & { filePath: string })[]): GhostMethodInfo[] {
        const methodMap = new Map<string, {
            count: number,
            files: Set<string>,
            argCounts: Map<number, number>,
            isAsyncCount: number,
            rawCalls: string[]
        }>();

        for (const call of callSites) {
            const methodName = call.callType === 'method' ? call.calleeName : (call.callType === 'constructor' ? 'constructor' : 'default');
            
            const existing = methodMap.get(methodName) || {
                count: 0,
                files: new Set<string>(),
                argCounts: new Map<number, number>(),
                isAsyncCount: 0,
                rawCalls: []
            };

            existing.count++;
            existing.files.add(call.filePath);
            
            // Track argument counts to detect consistency
            const argCount = call.arguments?.length || 0;
            existing.argCounts.set(argCount, (existing.argCounts.get(argCount) || 0) + 1);

            // Heuristic for async: check if call was awaited or part of an async flow
            if (call.isAwaited) existing.isAsyncCount++;

            if (call.text) existing.rawCalls.push(call.text);
            
            methodMap.set(methodName, existing);
        }

        return Array.from(methodMap.entries()).map(([name, data]) => {
            const bestArgCount = this.getMostFrequent(data.argCounts);
            const isProbablyAsync = data.isAsyncCount / data.count > 0.5;
            const consistency = this.calculateConsistency(data.argCounts, data.count);
            
            return {
                name,
                callCount: data.count,
                fileCount: data.files.size,
                inferredSignature: this.buildSignature(name, bestArgCount, isProbablyAsync),
                confidence: this.computeEnhancedConfidence(data.count, data.files.size, consistency)
            };
        });
    }

    private getMostFrequent(map: Map<number, number>): number {
        let maxCount = -1;
        let mostFrequent = 0;
        for (const [val, count] of map.entries()) {
            if (count > maxCount) {
                maxCount = count;
                mostFrequent = val;
            }
        }
        return mostFrequent;
    }

    private calculateConsistency(argCounts: Map<number, number>, total: number): number {
        if (total === 0) return 0;
        const maxFreq = Math.max(...Array.from(argCounts.values()));
        return maxFreq / total; // 1.0 means perfectly consistent
    }

    private buildSignature(name: string, argCount: number, isAsync: boolean): string {
        const args = Array.from({ length: argCount }, (_, i) => `arg${i}: any`).join(', ');
        const returnType = isAsync ? 'Promise<any>' : 'any';
        return `${name}(${args}): ${returnType}`;
    }

    private computeEnhancedConfidence(callCount: number, fileCount: number, consistency: number): 'high' | 'medium' | 'low' {
        let base: 'high' | 'medium' | 'low' = 'low';
        if (callCount >= 8 && fileCount >= 2 && consistency > 0.8) base = 'high';
        else if (callCount >= 3 || (fileCount >= 2 && consistency > 0.5)) base = 'medium';
        
        // Downgrade if consistency is very low
        if (consistency < 0.4 && base === 'high') return 'medium';
        return base;
    }

    private chooseBestSignature(name: string, signatures: string[]): string {
        if (signatures.length === 0) return `${name}(...)`;
        return signatures.sort((a, b) => a.length - b.length)[0];
    }
}
