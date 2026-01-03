import * as fs from 'fs';
import { TopologyInfo } from '../../types.js';
import { ImportExtractor } from '../ImportExtractor.js';
import { ExportExtractor } from '../ExportExtractor.js';
import { AstManager } from '../AstManager.js';
import { AdaptiveFlowMetrics } from '../../utils/AdaptiveFlowMetrics.js';

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
    private readonly IMPORT_STAR_PATTERN = new RegExp("import\\s+\\*\\s+as\\s+([\\w$]+)\\s+from\\s+['\"]([^'\"]+)['\"]", "g");
    private readonly DYNAMIC_IMPORT_PATTERN = new RegExp("import\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)", "g");
    private readonly EXPORT_NAMED_PATTERN = new RegExp("export\\s+(?:const|let|var|function|class|interface|type|enum)\\s+([\\w$]+)", "g");
    private readonly EXPORT_DEFAULT_PATTERN = new RegExp("export\\s+default\\s+", "g");
    private readonly EXPORT_FROM_PATTERN = new RegExp("export\\s+(?:{[^}]*}|\\*)\\s+from\\s+['\"]([^'\"]+)['\"]", "g");
    
    private readonly TOP_LEVEL_FUNCTION_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?function\\s+([\\w$]+)\\s*\\(", "gm");
    private readonly TOP_LEVEL_CLASS_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?class\\s+([\\w$]+)", "gm");
    private readonly TOP_LEVEL_INTERFACE_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?interface\\s+([\\w$]+)", "gm");
    private readonly TOP_LEVEL_TYPE_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?type\\s+([\\w$]+)\\s*=", "gm");
    private readonly TOP_LEVEL_CONST_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?const\\s+([\\w$]+)\\s*=", "gm");
    private readonly TOP_LEVEL_LET_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?let\\s+([\\w$]+)\\s*=", "gm");
    private readonly TOP_LEVEL_VAR_PATTERN = new RegExp("(?:^|\\n)\\s*(?:export\\s+)?var\\s+([\\w$]+)\\s*=", "gm");
    
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
            const extractionTimeMs = performance.now() - startTime;
            if (regexResult.confidence >= 0.95) {
                console.debug(`[TopologyScanner] Regex success for ${filePath} (${extractionTimeMs.toFixed(2)}ms, confidence=${regexResult.confidence.toFixed(2)})`);
                AdaptiveFlowMetrics.recordTopologyScan(extractionTimeMs, false);
                return { ...regexResult, extractionTimeMs, fallbackUsed: false };
            }
            console.warn(`[TopologyScanner] Low confidence (${regexResult.confidence.toFixed(2)}) for ${filePath}, using AST fallback.`);
            return await this.fallbackToAST(filePath, content, startTime);
        } catch (error) {
            console.error(`[TopologyScanner] Regex extraction failed for ${filePath}:`, error);
            const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
            return await this.fallbackToAST(filePath, content, startTime);
        }
    }
    
    private extractViaRegex(filePath: string, content: string): Omit<TopologyInfo, 'extractionTimeMs' | 'fallbackUsed'> {
        const importsMap = new Map<string, TopologyInfo['imports'][number]>();
        const exports: TopologyInfo['exports'] = [];
        const topLevelSymbols: TopologyInfo['topLevelSymbols'] = [];
        const dynamicImports: TopologyInfo['imports'] = [];
        const cleanContent = this.removeComments(content);

        const ensureImportEntry = (source: string) => {
            if (!importsMap.has(source)) {
                importsMap.set(source, { source, isDefault: false, namedImports: [], isTypeOnly: false, isDynamic: false });
            }
            return importsMap.get(source)!;
        };

        const appendUnique = (collection: string[], value: string) => {
            if (!value) return;
            if (!collection.includes(value)) {
                collection.push(value);
            }
        };

        let match: RegExpExecArray | null;

        this.IMPORT_PATTERN.lastIndex = 0;
        while ((match = this.IMPORT_PATTERN.exec(cleanContent)) !== null) {
            const source = match[1];
            const statement = match[0];
            const entry = ensureImportEntry(source);
            const braceMatches = statement.match(/{([^}]+)}/g) ?? [];
            for (const block of braceMatches) {
                const names = block
                    .replace('{', '')
                    .replace('}', '')
                    .split(',')
                    .map((token) => token.trim())
                    .filter(Boolean);
                for (const rawName of names) {
                    const cleaned = rawName.replace(/^type\s+/, '').replace(/\s+as\s+.+$/, '');
                    appendUnique(entry.namedImports, cleaned);
                    if (/^type\s+/.test(rawName) || /import\s+type/.test(statement)) {
                        entry.isTypeOnly = true;
                    }
                }
            }
            if (/import\s+type\s+/.test(statement)) {
                entry.isTypeOnly = true;
            }
        }

        this.IMPORT_STAR_PATTERN.lastIndex = 0;
        while ((match = this.IMPORT_STAR_PATTERN.exec(cleanContent)) !== null) {
            const alias = match[1];
            const source = match[2];
            const entry = ensureImportEntry(source);
            appendUnique(entry.namedImports, `* as ${alias}`);
        }

        this.IMPORT_DEFAULT_PATTERN.lastIndex = 0;
        while ((match = this.IMPORT_DEFAULT_PATTERN.exec(cleanContent)) !== null) {
            const name = match[1];
            const source = match[2];
            const entry = ensureImportEntry(source);
            entry.isDefault = true;
            appendUnique(entry.namedImports, name);
            if (/import\s+type\s+/.test(match[0])) {
                entry.isTypeOnly = true;
            }
        }

        this.DYNAMIC_IMPORT_PATTERN.lastIndex = 0;
        while ((match = this.DYNAMIC_IMPORT_PATTERN.exec(cleanContent)) !== null) {
            dynamicImports.push({
                source: match[1],
                isDefault: false,
                namedImports: [],
                isTypeOnly: false,
                isDynamic: true
            });
        }

        this.EXPORT_NAMED_PATTERN.lastIndex = 0;
        while ((match = this.EXPORT_NAMED_PATTERN.exec(cleanContent)) !== null) {
            exports.push({
                name: match[1],
                isDefault: false,
                isTypeOnly: /export\s+(?:type|interface)/.test(match[0])
            });
        }

        if (this.EXPORT_DEFAULT_PATTERN.test(cleanContent)) {
            exports.push({ name: 'default', isDefault: true, isTypeOnly: false });
        }

        this.EXPORT_FROM_PATTERN.lastIndex = 0;
        while ((match = this.EXPORT_FROM_PATTERN.exec(cleanContent)) !== null) {
            exports.push({ name: '*', isDefault: false, isTypeOnly: false, reExportFrom: match[1] });
        }

        const symbolsFound = new Set<string>();
        const addSymbol = (name: string, kind: TopologyInfo['topLevelSymbols'][number]['kind'], exported: boolean, index: number) => {
            if (!name || symbolsFound.has(name)) return;
            symbolsFound.add(name);
            topLevelSymbols.push({ name, kind, exported, lineNumber: this.getLineNumber(content, index) });
        };

        this.TOP_LEVEL_FUNCTION_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_FUNCTION_PATTERN.exec(cleanContent)) !== null) {
            addSymbol(match[1], 'function', /export/.test(match[0]), match.index);
        }

        this.TOP_LEVEL_CLASS_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_CLASS_PATTERN.exec(cleanContent)) !== null) {
            addSymbol(match[1], 'class', /export/.test(match[0]), match.index);
        }

        this.TOP_LEVEL_INTERFACE_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_INTERFACE_PATTERN.exec(cleanContent)) !== null) {
            addSymbol(match[1], 'interface', /export/.test(match[0]), match.index);
        }

        this.TOP_LEVEL_TYPE_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_TYPE_PATTERN.exec(cleanContent)) !== null) {
            addSymbol(match[1], 'type', /export/.test(match[0]), match.index);
        }

        this.TOP_LEVEL_CONST_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_CONST_PATTERN.exec(cleanContent)) !== null) {
            addSymbol(match[1], 'const', /export/.test(match[0]), match.index);
        }

        this.TOP_LEVEL_LET_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_LET_PATTERN.exec(cleanContent)) !== null) {
            addSymbol(match[1], 'let', /export/.test(match[0]), match.index);
        }

        this.TOP_LEVEL_VAR_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_VAR_PATTERN.exec(cleanContent)) !== null) {
            addSymbol(match[1], 'var', /export/.test(match[0]), match.index);
        }

        const imports = [...importsMap.values(), ...dynamicImports];
        const confidence = this.calculateConfidence(content, imports, exports, topLevelSymbols);
        return { path: filePath, imports, exports, topLevelSymbols, confidence };
    }
    
    private removeComments(content: string): string {
        let result = '';
        let inString = false;
        let stringChar = '';
        let inSingleLineComment = false;
        let inMultiLineComment = false;

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            const next = content[i + 1];

            if (inSingleLineComment) {
                if (char === '\n') {
                    inSingleLineComment = false;
                    result += char;
                }
                continue;
            }

            if (inMultiLineComment) {
                if (char === '*' && next === '/') {
                    inMultiLineComment = false;
                    i++;
                }
                continue;
            }

            if (!inString) {
                if (char === '/' && next === '/') {
                    inSingleLineComment = true;
                    i++;
                    continue;
                }
                if (char === '/' && next === '*') {
                    inMultiLineComment = true;
                    i++;
                    continue;
                }
                if (char === '"' || char === '\'' || char === '`') {
                    inString = true;
                    stringChar = char;
                    result += char;
                    continue;
                }
                result += char;
                continue;
            }

            result += char;
            if (char === '\\') {
                if (i + 1 < content.length) {
                    result += content[++i];
                }
                continue;
            }
            if (char === stringChar) {
                inString = false;
                stringChar = '';
            }
        }

        return result;
    }
    
    private calculateConfidence(content: string, imports: TopologyInfo['imports'], exports: TopologyInfo['exports'], symbols: TopologyInfo['topLevelSymbols']): number {
        let confidence = 1.0;
        const dynamicImports = imports.filter(i => i.isDynamic).length;
        confidence -= dynamicImports * 0.05;
        const reExports = exports.filter(e => Boolean(e.reExportFrom)).length;
        confidence -= reExports * 0.03;
        const lines = content.split(/\r?\n/).length;
        const isVeryLargeFile = lines > 1000;
        if (isVeryLargeFile) {
            confidence -= 0.1;
        } else if (lines > 500) {
            confidence -= 0.05;
        }
        if (imports.length === 0 && exports.length === 0 && symbols.length === 0 && lines > 50) {
            confidence -= 0.2;
        }
        const standardImports = imports.filter(i => !i.isDynamic && !i.isTypeOnly).length;
        if (!isVeryLargeFile && standardImports > 0 && standardImports === imports.filter(i => !i.isDynamic).length) {
            confidence += 0.05;
        }
        return Math.max(0.0, Math.min(1.0, confidence));
    }
    
    private getLineNumber(content: string, index: number): number {
        return content.substring(0, index).split(new RegExp("\\r?\\n")).length;
    }
    
    private async fallbackToAST(filePath: string, content: string, startTime: number): Promise<TopologyInfo> {
        try {
            await this.astManager.parseFile(filePath, content);
            const imports = await this.importExtractor.extractImports(filePath);
            const exports = await this.exportExtractor.extractExports(filePath);
            const topologyImports: TopologyInfo['imports'] = imports.map(imp => ({ source: imp.specifier, isDefault: imp.importType === 'default', namedImports: imp.what, isTypeOnly: false, isDynamic: false }));
            const topologyExports: TopologyInfo['exports'] = exports.map(exp => ({ name: exp.name, isDefault: exp.exportType === 'default', isTypeOnly: false, reExportFrom: exp.reExportFrom }));
            const topLevelSymbols: TopologyInfo['topLevelSymbols'] = exports.map(exp => ({ name: exp.name, kind: this.inferSymbolKind(exp.name, content), exported: true, lineNumber: exp.line ?? 0 }));
            const extractionTimeMs = performance.now() - startTime;
            console.debug(`[TopologyScanner] AST fallback success for ${filePath} (${extractionTimeMs.toFixed(2)}ms)`);
            AdaptiveFlowMetrics.recordTopologyScan(extractionTimeMs, true);
            return { path: filePath, imports: topologyImports, exports: topologyExports, topLevelSymbols, confidence: 1.0, fallbackUsed: true, extractionTimeMs };
        } catch (error) {
            const duration = performance.now() - startTime;
            AdaptiveFlowMetrics.recordTopologyScan(duration, true);
            return { path: filePath, imports: [], exports: [], topLevelSymbols: [], confidence: 0, fallbackUsed: true, extractionTimeMs: duration, error: error instanceof Error ? error.message : String(error) };
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
