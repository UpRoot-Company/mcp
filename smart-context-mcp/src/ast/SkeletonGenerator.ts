import { AstManager } from './AstManager.js';
import { SymbolInfo, SkeletonOptions, SkeletonDetailLevel } from '../types.js';
import { Query } from 'web-tree-sitter';
import { SymbolExtractor } from './extraction/SymbolExtractor.js';

interface FoldQuery {
    query: string;
    shouldFold?: (node: any) => boolean;
    replacement?: string;
}

const LANGUAGE_CONFIG: Record<string, FoldQuery> = {
    typescript: {
        query: `
            (statement_block) @fold
        `,
        replacement: '{ /* ... implementation hidden ... */ }'
    },
    tsx: {
        query: `
            (statement_block) @fold
        `,
        replacement: '{ /* ... implementation hidden ... */ }'
    },
    javascript: {
        query: `
            (statement_block) @fold
        `,
        replacement: '{ /* ... implementation hidden ... */ }'
    },
    python: {
        query: `
            (block) @fold
        `,
        replacement: '... # implementation hidden',
        shouldFold: (node: any) => {
            if (node.parent && node.parent.type === 'class_definition') {
                return false;
            }
            return true;
        }
    },
};

type ResolvedSkeletonOptions = {
    includeMemberVars: boolean;
    includeComments: boolean;
    detailLevel: SkeletonDetailLevel;
    maxMemberPreview: number;
};

export class SkeletonGenerator {
    private astManager: AstManager;
    private queryCache = new Map<string, any>(); 
    private symbolExtractor: SymbolExtractor;

    constructor() {
        this.astManager = AstManager.getInstance();
        this.symbolExtractor = new SymbolExtractor();
    }

    public async getParserForFile(filePath: string) {
        return this.astManager.getParserForFile(filePath);
    }

    public async getLanguageForFile(filePath: string) {
        return this.astManager.getLanguageForFile(filePath);
    }

    public async generateSkeleton(filePath: string, content: string, options: SkeletonOptions = {}): Promise<string> {
        if (typeof content !== 'string') return '';

        if (!this.astManager.supportsQueries()) {
            return content;
        }

        let doc;
        try {
            doc = await this.astManager.parseFile(filePath, content);
        } catch (e) {
            return content;
        }

        const lang = await this.astManager.getLanguageForFile(filePath);
        const langId = this.astManager.getLanguageId(filePath);
        const config = this.getLanguageConfig(filePath);
        if (!config) return content;
        const resolvedOptions = this.resolveOptions(options);

        let rootNode: any | null = null;
        try {
            rootNode = doc.rootNode;

            const maybeHasError = rootNode?.hasError;
            const rootHasError = typeof maybeHasError === 'function'
                ? maybeHasError.call(rootNode)
                : Boolean(maybeHasError);

            if (rootHasError) {
                throw new Error('Tree-sitter parse error detected while building skeleton');
            }
            const queryKey = `${langId}:${config.query}`; 
            let query = this.queryCache.get(queryKey);
            if (!query) {
                query = new Query(lang, config.query);
                this.queryCache.set(queryKey, query);
            }

            const matches = query.matches(rootNode);
            const rangesToFold: { start: number; end: number; }[] = [];

            for (const match of matches) {
                for (const capture of match.captures) {
                    if (capture.name === 'fold') {
                        const node = capture.node;
                        if (config.shouldFold && !config.shouldFold(node)) {
                            continue;
                        }
                        if (!this.shouldFoldByDetailLevel(node, resolvedOptions.detailLevel, content)) {
                            continue;
                        }
                        rangesToFold.push({
                            start: node.startIndex,
                            end: node.endIndex
                        });
                    }
                }
            }

            rangesToFold.sort((a, b) => a.start - b.start || b.end - a.end);

            const rootRanges: { start: number; end: number; }[] = [];
            let lastEnd = -1;

            for (const range of rangesToFold) {
                if (range.start >= lastEnd) {
                    rootRanges.push(range);
                    lastEnd = range.end;
                }
            }

            let skeleton = content;
            for (let i = rootRanges.length - 1; i >= 0; i--) {
                const range = rootRanges[i];
                const prefix = skeleton.substring(0, range.start);
                const suffix = skeleton.substring(range.end);
                skeleton = prefix + (config.replacement || '...') + suffix;
            }

            return this.applySkeletonPostProcessing(skeleton, resolvedOptions);

        } catch (error) {
            throw error; 
        } finally {
            doc?.dispose?.();
        }
    }

    private resolveOptions(options: SkeletonOptions): ResolvedSkeletonOptions {
        return {
            includeMemberVars: options.includeMemberVars !== false,
            includeComments: options.includeComments === true,
            detailLevel: options.detailLevel ?? "standard",
            maxMemberPreview: Math.max(1, options.maxMemberPreview ?? 3)
        };
    }

    private shouldFoldByDetailLevel(node: any, detailLevel: SkeletonDetailLevel, content: string): boolean {
        if (detailLevel === "detailed") {
            const lineLength = this.countLinesInRange(content, node.startIndex, node.endIndex);
            return lineLength > 50;
        }
        return true;
    }

    private countLinesInRange(content: string, start: number, end: number): number {
        const slice = content.substring(start, end);
        if (!slice) {
            return 0;
        }
        return slice.split(/\r?\n/).length;
    }

    private applySkeletonPostProcessing(content: string, options: ResolvedSkeletonOptions): string {
        const lines = content.split(/\r?\n/);
        const processed: string[] = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!options.includeComments && this.isCommentText(trimmed)) {
                continue;
            }
            if (!options.includeMemberVars && this.isMemberVariableLine(trimmed)) {
                continue;
            }
            let nextLine = line;
            if (options.includeMemberVars) {
                nextLine = this.limitMemberPreview(nextLine, options.maxMemberPreview);
            }
            processed.push(nextLine);
        }
        let output = processed.join("\n");
        if (options.detailLevel === "minimal") {
            output = this.keepEssentialLinesOnly(output);
        }
        output = this.collapseBlankLines(output);
        return output;
    }

    private isCommentText(trimmed: string): boolean {
        return /^(\*|\#|\/\/|\/\*|<!--)/.test(trimmed);
    }

    private isMemberVariableLine(trimmed: string): boolean {
        if (/^(public|protected|private)\s+(static\s+)?(readonly\s+)?\$?[A-Za-z_][\w$]*\s*[:=;]/.test(trimmed)) {
            return true;
        }
        if (/^(readonly\s+)?[A-Za-z_][\w$]*\s*:\s*[\w\<\>\[\]\s]+(?:;|=)/.test(trimmed)) {
            return true;
        }
        if (/^\$[A-Za-z_][\w$]*\s*=/.test(trimmed)) {
            return true;
        }
        if (/^[A-Za-z_][\w$]*\s*=\s*[^=]+$/.test(trimmed) && !/\bfunction\b/.test(trimmed)) {
            return true;
        }
        return false;
    }

    private limitMemberPreview(line: string, maxEntries: number): string {
        if (maxEntries <= 0) {
            return line;
        }
        const arrayMatch = line.match(/=\s*\[(.+)\](;)?/);
        if (arrayMatch) {
            const entries = arrayMatch[1].split(",").map(part => part.trim()).filter(Boolean);
            if (entries.length > maxEntries) {
                const limited = entries.slice(0, maxEntries).join(", ");
                return line.replace(
                    arrayMatch[0],
                    `= [${limited}, ...${entries.length - maxEntries} more]${arrayMatch[2] ?? ""}`
                );
            }
            return line;
        }
        const objectMatch = line.match(/=\s*\{(.+)\}(;)?/);
        if (objectMatch) {
            const entries = objectMatch[1].split(",").map(part => part.trim()).filter(Boolean);
            if (entries.length > maxEntries) {
                const limited = entries.slice(0, maxEntries).join(", ");
                return line.replace(
                    objectMatch[0],
                    `= {${limited}, ...${entries.length - maxEntries} more}${objectMatch[2] ?? ""}`
                );
            }
        }
        return line;
    }

    private keepEssentialLinesOnly(content: string): string {
        const essentialPattern = /(class|interface|function|def|enum|struct|trait|module|namespace|export\s+(class|function|const)|constructor|private|public|protected|greet)/i;
        const lines = content.split(/\r?\n/);
        const essentials: string[] = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                continue;
            }
            if (essentialPattern.test(trimmed)) {
                essentials.push(line);
            }
        }
        return essentials.join("\n");
    }

    private collapseBlankLines(content: string): string {
        const lines = content.split(/\r?\n/);
        const filtered: string[] = [];
        for (const line of lines) {
            if (line.trim().length === 0) {
                if (filtered.length === 0 || filtered[filtered.length - 1].trim().length === 0) {
                    continue;
                }
            }
            filtered.push(line);
        }
        return filtered.join("\n");
    }

    public async generateStructureJson(filePath: string, content: string): Promise<SymbolInfo[]> {
        return this.symbolExtractor.generateStructureJson(filePath, content, this.astManager);
    }

    public async findIdentifiers(filePath: string, content: string, targetNames: string[]): Promise<{ name: string, range: any }[]> {
        if (typeof content !== 'string') return [];
        
        if (!this.astManager.supportsQueries()) {
            return [];
        }

        let doc;
        try {
            doc = await this.astManager.parseFile(filePath, content);
        } catch (e) {
            return [];
        }

        const lang = await this.astManager.getLanguageForFile(filePath);
        if (!lang) return [];

        let rootNode: any | null = null;
        const results: { name: string, range: any }[] = [];

        try {
            rootNode = doc.rootNode;
            const query = new Query(lang, `
                (identifier) @id
                (property_identifier) @id
                (type_identifier) @id
                (shorthand_property_identifier_pattern) @id
            `);
            const matches = query.matches(rootNode);
            
            const targetSet = new Set(targetNames);

            for (const match of matches) {
                const node = match.captures[0].node;
                if (targetSet.has(node.text)) {
                    results.push({
                        name: node.text,
                        range: {
                            startLine: node.startPosition.row,
                            endLine: node.endPosition.row,
                            startByte: node.startIndex,
                            endByte: node.endIndex
                        }
                    });
                }
            }
        } catch (error) {
            console.error(`Error finding identifiers in ${filePath}:`, error);
        } finally {
            doc?.dispose?.();
        }
        return results;
    }

    private getLanguageConfig(filePath: string): FoldQuery | undefined {
        const ext = filePath.split('.').pop()?.toLowerCase();
        if (['ts', 'mts', 'cts'].includes(ext!)) return LANGUAGE_CONFIG.typescript;
        if (['tsx'].includes(ext!)) return LANGUAGE_CONFIG.tsx;
        if (['js', 'mjs', 'cjs', 'jsx'].includes(ext!)) return LANGUAGE_CONFIG.javascript;
        if (['py'].includes(ext!)) return LANGUAGE_CONFIG.python;
        return undefined;
    }
}
