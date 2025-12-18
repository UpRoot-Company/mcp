import { AstManager } from './AstManager.js';
import { SymbolInfo, SkeletonOptions, SkeletonDetailLevel } from '../types.js';
import { Query } from 'web-tree-sitter';
import { SymbolExtractor } from './extraction/SymbolExtractor.js';
import { CallSiteAnalyzer } from './analysis/CallSiteAnalyzer.js';

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
    includeSummary: boolean;
    detailLevel: SkeletonDetailLevel;
    maxMemberPreview: number;
};

export class SkeletonGenerator {
    private astManager: AstManager;
    private queryCache = new Map<string, any>();
    private symbolExtractor: SymbolExtractor;
    private callSiteAnalyzer: CallSiteAnalyzer;

    constructor() {
        this.astManager = AstManager.getInstance();
        this.symbolExtractor = new SymbolExtractor();
        this.callSiteAnalyzer = new CallSiteAnalyzer();
    }

    public async getParserForFile(filePath: string) {
        return this.astManager.getParserForFile(filePath);
    }

    public async getLanguageForFile(filePath: string) {
        return this.astManager.getLanguageForFile(filePath);
    }

    public async generateSkeleton(filePath: string, content: string, options: SkeletonOptions = {}): Promise<string> {
        if (!this.astManager.supportsQueries()) {
            return content;
        }

        let doc: any;
        try {
            doc = await this.astManager.parseFile(filePath, content);
            const lang = await this.astManager.getLanguageForFile(filePath);
            const langId = this.astManager.getLanguageId(filePath);
            const config = this.getLanguageConfig(filePath);
            if (!config || !lang) return content;

            const resolvedOptions = this.resolveOptions(options);
            const rootNode: any | null = doc.rootNode;

            if (!rootNode) return content;

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
            const rangesToFold: { start: number; end: number; replacement?: string }[] = [];

            for (const match of matches) {
                for (const capture of match.captures) {
                    const node = capture.node;
                    if (config.shouldFold && !config.shouldFold(node)) {
                        continue;
                    }
                    if (this.shouldFoldByDetailLevel(node, resolvedOptions.detailLevel, content)) {
                        let replacement = config.replacement;

                        // Tier 2: Semantic Summary
                        if (resolvedOptions.includeSummary) {
                            const summary = await this.generateSemanticSummary(node, lang, langId);
                            if (summary) {
                                replacement = replacement?.replace('implementation hidden', `implementation hidden; ${summary}`);
                            }
                        }

                        rangesToFold.push({
                            start: node.startIndex,
                            end: node.endIndex,
                            replacement: replacement ?? config.replacement
                        });
                    }
                }
            }

            rangesToFold.sort((a, b) => a.start - b.start || b.end - a.end);

            const rootRanges: typeof rangesToFold = [];
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
                skeleton = prefix + (range.replacement ?? config.replacement ?? '') + suffix;
            }

            return this.applySkeletonPostProcessing(skeleton, resolvedOptions);
        } finally {
            doc?.dispose?.();
        }
    }

    private async generateSemanticSummary(node: any, lang: any, langId: string): Promise<string | null> {
        const callQuery = (this.callSiteAnalyzer as any).getCallQuery(langId, lang);
        if (!callQuery) return null;

        const matches = callQuery.matches(node);
        const calls = new Set<string>();

        for (const match of matches) {
            const parsed = (this.callSiteAnalyzer as any).parseCallMatch(match);
            if (parsed) {
                const name = parsed.calleeObject
                    ? `${parsed.calleeObject}.${parsed.calleeName}`
                    : parsed.calleeName;
                calls.add(name);
            }
        }

        if (calls.size === 0) return null;

        const callsList = Array.from(calls).slice(0, 5);
        const moreCount = calls.size - callsList.length;
        let summary = `calls: ${callsList.join(', ')}`;
        if (moreCount > 0) summary += ` (+${moreCount} more)`;

        return summary;
    }

    private resolveOptions(options: SkeletonOptions): ResolvedSkeletonOptions {
        return {
            includeMemberVars: options.includeMemberVars ?? true,
            includeComments: options.includeComments ?? false,
            includeSummary: options.includeSummary ?? false,
            detailLevel: options.detailLevel ?? 'standard',
            maxMemberPreview: Math.max(1, options.maxMemberPreview ?? 3)
        };
    }

    private shouldFoldByDetailLevel(node: any, detailLevel: SkeletonDetailLevel, content: string): boolean {
        const lineLength = this.countLinesInRange(content, node.startIndex, node.endIndex);
        if (detailLevel === 'detailed') {
            return lineLength > 20;
        }
        if (detailLevel === 'minimal') {
            return true;
        }
        // standard (default)
        return lineLength >= 3;
    }

    private countLinesInRange(content: string, start: number, end: number): number {
        const slice = content.substring(start, end);
        return slice.split(/\r?\n/).length;
    }

    private applySkeletonPostProcessing(content: string, options: ResolvedSkeletonOptions): string {
        const lines = content.split(/\r?\n/);
        const processed: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "") continue;

            if (!options.includeComments && this.isCommentText(trimmed)) {
                continue;
            }
            if (!options.includeMemberVars && this.isMemberVariableLine(trimmed)) {
                continue;
            }

            let nextLine = line;
            if (this.isMemberVariableLine(trimmed)) {
                nextLine = this.limitMemberPreview(nextLine, options.maxMemberPreview);
            }

            processed.push(nextLine);
        }

        if (options.detailLevel === 'minimal') {
            const minimalPattern = /(class|interface|function|def|enum|struct|trait|module|namespace|constructor)/i;
            return processed
                .filter(line => minimalPattern.test(line))
                .join("\n");
        }

        return this.collapseBlankLines(processed.join("\n"));
    }

    private isCommentText(trimmed: string): boolean {
        return /^(\*|\#|\/\/|\/\*|<!--)/.test(trimmed);
    }

    private isMemberVariableLine(trimmed: string): boolean {
        return /^(public|protected|private)\s+(static\s+)?(readonly\s+)?\$?[A-Za-z_][\w$]*\s*[:=;]/.test(trimmed) ||
            /^(readonly\s+)?[A-Za-z_][\w$]*\s*:\s*[\w\<\\>\[\]\s]+(?:;|=)/.test(trimmed) ||
            /^\$[A-Za-z_][\w$]*\s*=/.test(trimmed) ||
            (/^[A-Za-z_][\w$]*\s*=\s*[^=]+$/.test(trimmed) && !/\bfunction\b/.test(trimmed));
    }

    private limitMemberPreview(line: string, maxEntries: number): string {
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

    private collapseBlankLines(content: string): string {
        const lines = content.split(/\r?\n/);
        const filtered: string[] = [];
        for (const line of lines) {
            if (line.trim() === "" && filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
                continue;
            }
            filtered.push(line);
        }
        return filtered.join("\n");
    }

    public async generateStructureJson(filePath: string, content: string): Promise<SymbolInfo[]> {
        return this.symbolExtractor.generateStructureJson(filePath, content, this.astManager);
    }

    public async findIdentifiers(filePath: string, content: string, targetNames: string[]): Promise<{ name: string, range: any }[]> {
        if (!this.astManager.supportsQueries()) {
            return [];
        }

        let doc: any;
        try {
            doc = await this.astManager.parseFile(filePath, content);
            const lang = await this.astManager.getLanguageForFile(filePath);
            const rootNode: any | null = doc.rootNode;
            const results: { name: string, range: any }[] = [];

            if (!rootNode || !lang) return [];

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
            return results;
        } catch (error) {
            console.error(`Error finding identifiers in ${filePath}:`, error);
            return [];
        } finally {
            doc?.dispose?.();
        }
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
