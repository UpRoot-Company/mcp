import path from 'path';
import { IFileSystem } from '../../platform/FileSystem.js';
import { TrigramIndex } from '../TrigramIndex.js';
import { BM25FRanking } from '../Ranking.js';
import { SymbolIndex, Document } from '../../types.js';
import { FilenameScorer } from './FilenameScorer.js';
import { CommentParser } from '../../utils/CommentParser.js';

export class HybridScorer {
    private filenameScorer = new FilenameScorer();
    private commentParser = new CommentParser();

    constructor(
        private rootPath: string,
        private fileSystem: IFileSystem,
        private trigramIndex: TrigramIndex,
        private bm25Ranking: BM25FRanking,
        private symbolIndex?: SymbolIndex
    ) {}

    public async scoreFile(
        filePath: string,
        keywords: string[],
        normalizedQuery: string,
        patterns?: string[]
    ): Promise<{
        total: number;
        signals: string[];
        breakdown: {
            content: number;
            filename: number;
            symbol: number;
            comment: number;
            pattern: number;
            filenameMatchType: "exact" | "partial" | "none";
        }
    }> {
        let totalScore = 0;
        const signals: string[] = [];
        const breakdown = {
            content: 0,
            filename: 0,
            symbol: 0,
            comment: 0,
            pattern: 0,
            filenameMatchType: "none" as "exact" | "partial" | "none"
        };

        // Signal 1: Trigram content similarity
        if (normalizedQuery) {
            const trigramScore = await this.getTrigramScore(filePath, normalizedQuery);
            if (trigramScore > 0) {
                totalScore += trigramScore * 0.5;
                breakdown.content = trigramScore * 0.5;
                signals.push('content');
            }
        }

        // Signal 2: Filename matching
        if (keywords.length > 0) {
            const matchType = this.filenameScorer.scoreFilename(filePath, keywords);
            if (matchType !== "none") {
                const filenameWeight = matchType === "exact" ? 2 : 1;
                const filenameScore = filenameWeight * 10;
                totalScore += filenameScore;
                breakdown.filename = filenameScore;
                breakdown.filenameMatchType = matchType;
                signals.push('filename');
            }
        }

        // Signal 3: Symbol name matching
        if (this.symbolIndex && keywords.length > 0) {
            const symbolScore = await this.scoreSymbols(filePath, keywords);
            if (symbolScore > 0) {
                totalScore += symbolScore * 8;
                breakdown.symbol = symbolScore * 8;
                signals.push('symbol');
            }
        }

        // Signal 4: Comment matching
        if (keywords.length > 0) {
            const commentScore = await this.scoreComments(filePath, keywords);
            if (commentScore > 0) {
                totalScore += commentScore * 3;
                breakdown.comment = commentScore * 3;
                signals.push('comment');
            }
        }

        // Signal 5: Direct content keyword matching (fallback when trigram score is zero)
        if (keywords.length > 0 && breakdown.content === 0) {
            const directContentScore = await this.scoreContentMatches(filePath, keywords);
            if (directContentScore > 0) {
                totalScore += directContentScore;
                breakdown.content = directContentScore;
                if (!signals.includes('content')) {
                    signals.push('content');
                }
            }
        }

        // Signal 6: Patterns
        if (patterns && patterns.length > 0) {
            const patternScore = await this.scorePatterns(filePath, patterns);
            if (patternScore > 0) {
                totalScore += patternScore;
                breakdown.pattern = patternScore;
                signals.push('pattern');
            }
        }

        // Signal 7: Path depth penalty
        const depthPenalty = this.calculateDepthPenalty(filePath);
        totalScore -= depthPenalty;

        return { total: totalScore, signals, breakdown };
    }

    private async getTrigramScore(filePath: string, query: string): Promise<number> {
        const content = await this.fileSystem.readFile(filePath);
        const document: Document = {
            id: filePath,
            text: content,
            filePath: filePath,
            score: 0
        };
        const ranked = this.bm25Ranking.rank([document], query);
        return ranked[0]?.score || 0;
    }

    private async scoreSymbols(filePath: string, keywords: string[]): Promise<number> {
        if (!this.symbolIndex) {
            return 0;
        }
        try {
            const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
            let score = 0;

            for (const symbol of symbols) {
                const lowerSymbol = symbol.name.toLowerCase();
                for (const keyword of keywords) {
                    const lowerKw = keyword.toLowerCase();
                    if (lowerSymbol === lowerKw) {
                        score += 8;
                    } else if (lowerSymbol.includes(lowerKw)) {
                        score += 4;
                    }
                }
            }

            return score;
        } catch (error) {
            return 0;
        }
    }

    private async scoreComments(filePath: string, keywords: string[]): Promise<number> {
        try {
            const content = await this.fileSystem.readFile(filePath);
            const comments = this.commentParser.extractComments(content, filePath);

            let score = 0;
            for (const comment of comments) {
                const lowerComment = comment.toLowerCase();
                for (const keyword of keywords) {
                    if (lowerComment.includes(keyword.toLowerCase())) {
                        score += 3;
                    }
                }
            }

            return score;
        } catch (error) {
            return 0;
        }
    }

    private async scoreContentMatches(filePath: string, keywords: string[]): Promise<number> {
        try {
            const content = await this.fileSystem.readFile(filePath);
            const lowerContent = content.toLowerCase();
            let total = 0;

            for (const keyword of keywords) {
                const needle = keyword.toLowerCase();
                let index = lowerContent.indexOf(needle);
                while (index !== -1) {
                    total += 50;
                    index = lowerContent.indexOf(needle, index + needle.length);
                }
            }

            return total;
        } catch {
            return 0;
        }
    }

    private async scorePatterns(filePath: string, patterns: string[]): Promise<number> {
        try {
            let total = 0;
            for (const pattern of patterns) {
                const matches = await this.runFileGrep(pattern, filePath);
                if (matches.length > 0) {
                    total += 100 * matches.length;
                }
            }
            return total;
        } catch {
            return 0;
        }
    }

    private calculateDepthPenalty(filePath: string): number {
        const relativePath = path.relative(this.rootPath, filePath);
        const depth = relativePath.split(path.sep).length;
        return Math.max(0, (depth - 3) * 0.5);
    }

    // Helper from Search.ts
    private async runFileGrep(searchPattern: string, filePath: string): Promise<number[]> {
        let regex: RegExp;
        try {
            regex = new RegExp(searchPattern, "g");
        } catch {
            regex = new RegExp(this.escapeRegExp(searchPattern), "g");
        }
        let content: string;
        try {
            content = await this.fileSystem.readFile(filePath);
        } catch {
            return [];
        }
        const lines = content.split(/\r?\n/);
        const matches: number[] = [];
        for (let index = 0; index < lines.length; index++) {
            regex.lastIndex = 0;
            if (regex.test(lines[index])) {
                matches.push(index + 1);
            }
        }
        return matches;
    }

    private escapeRegExp(value: string, options: { wordBoundary?: boolean } = {}): string {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return options.wordBoundary ? `\\b${escaped}\\b` : escaped;
    }
}
