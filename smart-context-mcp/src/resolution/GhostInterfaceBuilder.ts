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
        const methodMap = new Map<string, { count: number, files: Set<string>, signatures: Set<string> }>();

        for (const call of callSites) {
            // If it's a method call, the property name is the method name
            // If it's a direct call and calleeName is our symbolName, it might be a constructor or a direct function call
            const methodName = call.callType === 'method' ? call.calleeName : (call.callType === 'constructor' ? 'constructor' : 'default');
            
            const existing = methodMap.get(methodName) || { count: 0, files: new Set<string>(), signatures: new Set<string>() };
            existing.count++;
            existing.files.add(call.filePath);
            if (call.text) {
                // Heuristic: take the property part if it's a method call
                existing.signatures.add(call.text);
            }
            methodMap.set(methodName, existing);
        }

        return Array.from(methodMap.entries()).map(([name, data]) => ({
            name,
            callCount: data.count,
            fileCount: data.files.size,
            inferredSignature: this.chooseBestSignature(name, Array.from(data.signatures)),
            confidence: this.computeConfidence(data.count, data.files.size)
        }));
    }

    private chooseBestSignature(name: string, signatures: string[]): string {
        if (signatures.length === 0) return `${name}(...)`;
        // Prefer shorter signatures or ones that look like definitions
        return signatures.sort((a, b) => a.length - b.length)[0];
    }

    private computeConfidence(callCount: number, fileCount: number): 'high' | 'medium' | 'low' {
        if (callCount >= 10 && fileCount >= 3) return 'high';
        if (callCount >= 3) return 'medium';
        return 'low';
    }
}
