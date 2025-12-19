import path from 'path';
import { IFileSystem } from '../../platform/FileSystem.js';
import { TrigramIndex } from '../TrigramIndex.js';
import { BM25FRanking } from '../Ranking.js';
import { SymbolIndex } from '../../types.js';
import { FilenameScorer } from './FilenameScorer.js';
import { CommentParser } from '../../utils/CommentParser.js';
import { SignalNormalizer, FileContext } from './SignalNormalizer.js';
import { AdaptiveWeights } from './AdaptiveWeights.js';
import { QueryIntent } from '../search/QueryIntent.js';
import { DependencyGraph } from '../../ast/DependencyGraph.js';

export interface ScoredFileMatch {
    line: number;
    content: string;
}

export class HybridScorer {
    private filenameScorer = new FilenameScorer();
    private commentParser = new CommentParser();
    private normalizer = new SignalNormalizer();
    private adaptiveWeights = new AdaptiveWeights();

    constructor(
        private rootPath: string,
        private fileSystem: IFileSystem,
        private trigramIndex: TrigramIndex,
        private bm25Ranking: BM25FRanking,
        private symbolIndex?: SymbolIndex,
        private dependencyGraph?: DependencyGraph
    ) {}

    public async scoreFile(
        filePath: string,
        content: string,
        keywords: string[],
        normalizedQuery: string,
        contentScoreRaw: number,
        intent: QueryIntent,
        patterns?: string[],
        options: { wordBoundary?: boolean; caseSensitive?: boolean } = {}
    ): Promise<{
        total: number;
        signals: string[];
        breakdown: any;
        matches: ScoredFileMatch[];
    }> {
        const weights = this.adaptiveWeights.getWeights(intent);
        const signals: string[] = [];
        const breakdown: any = {
            filenameMatchType: "none"
        };
        const matches: ScoredFileMatch[] = [];

        const lines = content.split(/\r?\n/);
        const lineCount = lines.length;
        const context: FileContext = { lineCount };

        // 1. Trigram Score
        const trigramScore = this.normalizer.normalize(contentScoreRaw, 'trigram', context);
        if (trigramScore > 0) signals.push('content');

        // 2. Filename Score
        let filenameRaw = 0;
        if (keywords.length > 0) {
            const matchType = this.filenameScorer.scoreFilename(filePath, keywords, options);
            breakdown.filenameMatchType = matchType;
            if (matchType !== "none") {
                filenameRaw = matchType === "exact" ? 100 : 50;
            }
        }
        const filenameScore = this.normalizer.normalize(filenameRaw, 'filename', context);
        if (filenameScore > 0) signals.push('filename');

        // 3. Symbol Score
        let symbolRaw = 0;
        if (this.symbolIndex && keywords.length > 0) {
            symbolRaw = await this.scoreSymbols(filePath, keywords, options);
        }
        const symbolScore = this.normalizer.normalize(symbolRaw, 'symbol', context);
        if (symbolScore > 0) signals.push('symbol');

        // 4. Comment Score
        let commentRaw = 0;
        if (keywords.length > 0) {
            commentRaw = await this.scoreComments(filePath, content, keywords, options);
        }
        const commentScore = this.normalizer.normalize(commentRaw, 'comment', context);
        if (commentScore > 0) signals.push('comment');

        // 5. Additional Signals
        const testCoverageRaw = await this.scoreTestCoverage(filePath);
        const testCoverageScore = this.normalizer.normalize(testCoverageRaw, 'testCoverage', context);

        const recencyRaw = await this.calculateRecencyScore(filePath);
        const recencyScore = this.normalizer.normalize(recencyRaw, 'recency', context);

        const outboundRaw = await this.scoreOutboundImportance(filePath);
        const outboundScore = this.normalizer.normalize(outboundRaw, 'outboundImportance', context);

        // Collect matches
        if (keywords.length > 0) {
            const keywordMatches = this.findKeywordMatches(lines, keywords, options);
            matches.push(...keywordMatches);
        }
        if (patterns && patterns.length > 0) {
            const patternMatches = this.findPatternMatches(lines, patterns);
            matches.push(...patternMatches);
        }

        if (matches.length > 0 && !signals.includes('content')) {
            signals.push('content');
        }

        // Weighted Sum
        let totalScore = 
            trigramScore * weights.trigram +
            filenameScore * weights.filename +
            symbolScore * weights.symbol +
            commentScore * weights.comment +
            testCoverageScore * weights.testCoverage +
            recencyScore * weights.recency +
            outboundScore * weights.outboundImportance;

        totalScore *= 100;

        // Ensure small ranking differences are preserved even if BM25 score is low
        // but literal matches are present.
        if (matches.length > 0 && totalScore < 10) {
            totalScore = 10 + (contentScoreRaw / 100); 
        }

        if (patterns && patterns.length > 0) {
            const patternRaw = await this.scorePatterns(content, patterns);
            if (patternRaw > 0) {
                totalScore += patternRaw; 
                signals.push('pattern');
            }
        }

        breakdown.content = trigramScore;
        breakdown.filename = filenameScore;
        breakdown.symbol = symbolScore;
        breakdown.comment = commentScore;
        breakdown.testCoverage = testCoverageScore;
        breakdown.recency = recencyScore;
        breakdown.outboundImportance = outboundScore;

        return { total: totalScore, signals, breakdown, matches };
    }

    private findKeywordMatches(lines: string[], keywords: string[], options: { wordBoundary?: boolean; caseSensitive?: boolean } = {}): ScoredFileMatch[] {
        const matches: ScoredFileMatch[] = [];
        const flags = options.caseSensitive ? '' : 'i';
        const regexes = keywords.map(kw => {
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const pattern = options.wordBoundary ? `\\b${escaped}\\b` : escaped;
            return new RegExp(pattern, flags);
        });
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (regexes.some(regex => regex.test(line))) {
                matches.push({ line: i + 1, content: line });
                if (matches.length >= 10) break; 
            }
        }
        return matches;
    }

    private findPatternMatches(lines: string[], patterns: string[]): ScoredFileMatch[] {
        const matches: ScoredFileMatch[] = [];
        const regexes = patterns.map(p => {
            try {
                return new RegExp(p, 'i');
            } catch {
                return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), 'i');
            }
        });

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (regexes.some(regex => regex.test(line))) {
                matches.push({ line: i + 1, content: line });
                if (matches.length >= 10) break;
            }
        }
        return matches;
    }

    private async scoreSymbols(filePath: string, keywords: string[], options: { wordBoundary?: boolean; caseSensitive?: boolean } = {}): Promise<number> {
        if (!this.symbolIndex) return 0;
        try {
            const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
            let score = 0;
            const flags = options.caseSensitive ? '' : 'i';
            const regexes = keywords.map(kw => {
                const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const pattern = options.wordBoundary ? `\\b${escaped}\\b` : escaped;
                return new RegExp(pattern, flags);
            });

            for (const symbol of symbols) {
                for (const regex of regexes) {
                    if (regex.test(symbol.name)) {
                        const isExact = symbol.name.toLowerCase() === regex.source.replace(/\\b/g, '').toLowerCase();
                        score += isExact ? 32 : 16;
                    }
                }
            }
            return score;
        } catch { return 0; }
    }

    private async scoreComments(filePath: string, content: string, keywords: string[], options: { wordBoundary?: boolean; caseSensitive?: boolean } = {}): Promise<number> {
        try {
            const comments = this.commentParser.extractComments(content, filePath);
            let score = 0;
            const flags = options.caseSensitive ? '' : 'i';
            const regexes = keywords.map(kw => {
                const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const pattern = options.wordBoundary ? `\\b${escaped}\\b` : escaped;
                return new RegExp(pattern, flags);
            });

            for (const comment of comments) {
                for (const regex of regexes) {
                    if (regex.test(comment)) {
                        score += 10;
                    }
                }
            }
            return score;
        } catch { return 0; }
    }

    private async scorePatterns(content: string, patterns: string[]): Promise<number> {
        try {
            let total = 0;
            for (const pattern of patterns) {
                let regex: RegExp;
                try {
                    regex = new RegExp(pattern, 'g');
                } catch {
                    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), 'g');
                }
                const matches = content.match(regex);
                if (matches) {
                    total += 100 * matches.length;
                }
            }
            return total;
        } catch { return 0; }
    }

    private async scoreTestCoverage(filePath: string): Promise<number> {
        const ext = path.extname(filePath);
        const basename = path.basename(filePath, ext);
        const dir = path.dirname(filePath);
        
        const testCandidates = [
            path.join(dir, `${basename}.test${ext}`),
            path.join(dir, `${basename}.spec${ext}`),
            path.join(dir, '__tests__', `${basename}.test${ext}`)
        ];

        for (const testFile of testCandidates) {
            if (await this.fileSystem.exists(testFile)) return 1.0;
        }
        return 0.0;
    }

    private async calculateRecencyScore(filePath: string): Promise<number> {
        try {
            const stats = await this.fileSystem.stat(filePath);
            const ageDays = (Date.now() - stats.mtime) / (1000 * 60 * 60 * 24);
            if (ageDays < 7) return 1.0;
            if (ageDays < 30) return 0.8;
            if (ageDays < 90) return 0.6;
            return 0.4;
        } catch {
            return 0;
        }
    }

    private async scoreOutboundImportance(filePath: string): Promise<number> {
        if (!this.dependencyGraph) return 0;
        try {
            const importers = await this.dependencyGraph.getImporters(filePath);
            const inDegree = importers.length;
            return Math.min(1.0, Math.log2(Math.max(1, inDegree) + 1) / 7);
        } catch {
            return 0;
        }
    }
}
