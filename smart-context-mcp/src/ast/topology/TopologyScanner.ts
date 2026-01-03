import * as fs from 'fs';
import { TopologyInfo } from '../../types.js';
import { ImportExtractor } from '../ImportExtractor.js';
import { ExportExtractor } from '../ExportExtractor.js';
import { AstManager } from '../AstManager.js';

/**
 * TopologyScanner: Fast LOD 1 extraction using regex patterns.
 * Falls back to full AST parsing if regex confidence is low.
 */
export class TopologyScanner {
    private importExtractor: ImportExtractor;
    private exportExtractor: ExportExtractor;
    private astManager: AstManager;
    
    private readonly IMPORT_PATTERN = new RegExp("import\\s+(?:(?:type|typeof)\\s+)?(?:{[^}]*}|[\\w*]+|\\*\\s+as\\s+\\w+)(?:\\s*,\\s*(?:{[^}]*}|[\\w*]+))?\\s+from\\s+['\"]([^'\"]+)['\"]", "g");
    private readonly IMPORT_DEFAULT_PATTERN = new RegExp("import\\s+(?:(?:type|typeof)\\s+)?([\\w$]+)\\s+from\\s+['\"]([^'\"]+)['\"]", "g");
    private readonly EXPORT_NAMED_PATTERN = new RegExp("export\\s+(?:const|let|var|function|class|interface|type|enum)\\s+([\\w$]+)", "g");
    private readonly EXPORT_DEFAULT_PATTERN = new RegExp("export\\s+default\\s+", "g");
    private readonly EXPORT_FROM_PATTERN = new RegExp("export\\s+(?:{[^}]*}|\\*)\\s+from\\s+['\"]([^'\"]+)['\"]", "g");
    
    private readonly TOP_LEVEL_FUNCTION_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?function\\s+([\\w$]+)\\s*\\(", "gm");
    private readonly TOP_LEVEL_CLASS_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?class\\s+([\\w$]+)", "gm");
    private readonly TOP_LEVEL_INTERFACE_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?interface\\s+([\\w$]+)", "gm");
    private readonly TOP_LEVEL_TYPE_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?type\\s+([\\w$]+)\\s*=", "gm");
    private readonly TOP_LEVEL_CONST_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?const\\s+([\\w$]+)\\s*=", "gm");
    
    constructor(projectRoot: string = process.cwd()) {
        this.importExtractor = new ImportExtractor(projectRoot);
        this.exportExtractor = new ExportExtractor(projectRoot);
        this.astManager = AstManager.getInstance();
    }
    
    async extract(filePath: string): Promise<TopologyInfo> {
        const startTime = performance.now();
        try {
            if (!fs.existsSync(filePath)) throw new Error("File not found");
            const content = fs.readFileSync(filePath, 'utf-8');
            const regexResult = this.extractViaRegex(filePath, content);
            if (regexResult.confidence >= 0.95) {
                return { ...regexResult, extractionTimeMs: performance.now() - startTime, fallbackUsed: false };
            }
            return await this.fallbackToAST(filePath, content, startTime);
        } catch (error) {
            const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
            return await this.fallbackToAST(filePath, content, startTime);
        }
    }
    
    private extractViaRegex(filePath: string, content: string): Omit<TopologyInfo, 'extractionTimeMs' | 'fallbackUsed'> {
        const importsMap = new Map<string, any>();
        const exports: TopologyInfo['exports'] = [];
        const topLevelSymbols: TopologyInfo['topLevelSymbols'] = [];
        const cleanContent = this.removeComments(content);
        let match;
        
        this.IMPORT_PATTERN.lastIndex = 0;
        while ((match = this.IMPORT_PATTERN.exec(cleanContent)) !== null) {
            const source = match[1];
            const namedMatch = match[0].match(new RegExp("{([^}]+)}"));
            const namedImports = namedMatch ? namedMatch[1].split(',').map(s => s.trim().replace(new RegExp("\\s+as\\s+.+$"), "")) : [];
            importsMap.set(source, { source, isDefault: false, namedImports, isTypeOnly: match[0].indexOf("import type") !== -1, isDynamic: false });
        }
        
        this.IMPORT_DEFAULT_PATTERN.lastIndex = 0;
        while ((match = this.IMPORT_DEFAULT_PATTERN.exec(cleanContent)) !== null) {
            const name = match[1];
            const source = match[2];
            if (!importsMap.has(source)) {
                importsMap.set(source, { source, isDefault: true, namedImports: [name], isTypeOnly: match[0].indexOf("import type") !== -1, isDynamic: false });
            } else {
                const existing = importsMap.get(source);
                existing.isDefault = true;
                if (existing.namedImports.indexOf(name) === -1) existing.namedImports.push(name);
            }
        }
        
        this.EXPORT_NAMED_PATTERN.lastIndex = 0;
        while ((match = this.EXPORT_NAMED_PATTERN.exec(cleanContent)) !== null) {
            exports.push({ name: match[1], isDefault: false, isTypeOnly: match[0].indexOf("export type") !== -1 || match[0].indexOf("export interface") !== -1 });
        }
        
        if (this.EXPORT_DEFAULT_PATTERN.test(cleanContent)) {
            exports.push({ name: 'default', isDefault: true, isTypeOnly: false });
        }
        
        this.EXPORT_FROM_PATTERN.lastIndex = 0;
        while ((match = this.EXPORT_FROM_PATTERN.exec(cleanContent)) !== null) {
            exports.push({ name: '*', isDefault: false, isTypeOnly: false, reExportFrom: match[1] });
        }
        
        const symbolsFound = new Set<string>();
        const addSymbol = (name: string, kind: any, exported: boolean, index: number) => {
            if (!symbolsFound.has(name)) {
                symbolsFound.add(name);
                topLevelSymbols.push({ name, kind, exported, lineNumber: this.getLineNumber(content, index) });
            }
        };
        
        this.TOP_LEVEL_FUNCTION_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_FUNCTION_PATTERN.exec(cleanContent)) !== null) addSymbol(match[1], 'function', match[0].indexOf("export") !== -1, match.index);
        this.TOP_LEVEL_CLASS_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_CLASS_PATTERN.exec(cleanContent)) !== null) addSymbol(match[1], 'class', match[0].indexOf("export") !== -1, match.index);
        this.TOP_LEVEL_INTERFACE_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_INTERFACE_PATTERN.exec(cleanContent)) !== null) addSymbol(match[1], 'interface', match[0].indexOf("export") !== -1, match.index);
        this.TOP_LEVEL_TYPE_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_TYPE_PATTERN.exec(cleanContent)) !== null) addSymbol(match[1], 'type', match[0].indexOf("export") !== -1, match.index);
        this.TOP_LEVEL_CONST_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_CONST_PATTERN.exec(cleanContent)) !== null) addSymbol(match[1], 'const', match[0].indexOf("export") !== -1, match.index);
        
        const imports = Array.from(importsMap.values());
        const confidence = this.calculateConfidence(content, imports, exports, topLevelSymbols);
        return { path: filePath, imports, exports, topLevelSymbols, confidence };
    }
    
    private removeComments(content: string): string {
        return content.replace(new RegExp("\\/\\*[\\s\\S]*?\\*\\/", "g"), "").replace(new RegExp("\\/\\/.*$", "gm"), "");
    }
    
    private calculateConfidence(content: string, imports: any[], exports: any[], symbols: any[]): number {
        let confidence = 1.0;
        if (imports.filter(i => i.isDynamic).length > 0) confidence -= 0.1;
        if (exports.filter(e => e.reExportFrom).length > 0) confidence -= 0.1;
        
        // Use a more robust line counting method
        const lines = content.split(new RegExp("\\r?\\n")).length;
        
        if (lines > 1000) {
            confidence -= 0.2;
        } else if (lines > 500) {
            confidence -= 0.1;
        }
        
        if (imports.length === 0 && exports.length === 0 && lines > 50) {
            confidence -= 0.3;
        }
        
        return Math.max(0.0, Math.min(1.0, confidence));
    }
    
    private getLineNumber(content: string, index: number): number {
        return content.substring(0, index).split(new RegExp("\\r?\\n")).length;
    }
    
    private async fallbackToAST(filePath: string, content: string, startTime: number): Promise<TopologyInfo> {
        try {
            const imports = await this.importExtractor.extractImports(filePath);
            const exports = await this.exportExtractor.extractExports(filePath);
            const topologyImports: TopologyInfo['imports'] = imports.map(imp => ({ source: imp.specifier, isDefault: imp.importType === 'default', namedImports: imp.what, isTypeOnly: false, isDynamic: false }));
            const topologyExports: TopologyInfo['exports'] = exports.map(exp => ({ name: exp.name, isDefault: exp.exportType === 'default', isTypeOnly: false, reExportFrom: exp.reExportFrom }));
            const topLevelSymbols: TopologyInfo['topLevelSymbols'] = exports.map(exp => ({ name: exp.name, kind: this.inferSymbolKind(exp.name, content), exported: true, lineNumber: exp.line ?? 0 }));
            return { path: filePath, imports: topologyImports, exports: topologyExports, topLevelSymbols, confidence: 1.0, fallbackUsed: true, extractionTimeMs: performance.now() - startTime };
        } catch (error) {
            return { path: filePath, imports: [], exports: [], topLevelSymbols: [], confidence: 0, fallbackUsed: true, extractionTimeMs: performance.now() - startTime, error: error instanceof Error ? error.message : String(error) };
        }
    }
    
    private inferSymbolKind(name: string, content: string): any {
        if (content.indexOf("class " + name) !== -1) return "class";
        if (content.indexOf("function " + name) !== -1) return "function";
        if (content.indexOf("interface " + name) !== -1) return "interface";
        if (content.indexOf("type " + name) !== -1) return "type";
        return "const";
    }
}
