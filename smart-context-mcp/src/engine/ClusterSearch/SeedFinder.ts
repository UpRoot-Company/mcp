import { SymbolIndex } from "../../ast/SymbolIndex.js";
import { ClusterSeed } from "../../types/cluster.js";
import type { ParsedQuery } from "./QueryParser.js";

const DEFAULT_SEED_LIMIT = 20;
const SUPPORTED_SEED_TYPES = new Set([
    "class",
    "function",
    "method",
    "interface",
    "variable",
    "export",
    "type_alias"
]);

export class SeedFinder {
    constructor(private readonly symbolIndex: SymbolIndex) {}

    async findSeeds(query: ParsedQuery, limit: number = DEFAULT_SEED_LIMIT): Promise<ClusterSeed[]> {
        if (query.terms.length === 0 && !query.filters.file) {
            return [];
        }

        const allSymbols = await this.symbolIndex.getAllSymbols();
        const candidates: ClusterSeed[] = [];

        for (const [filePath, symbols] of allSymbols) {
            if (query.filters.file && !filePath.includes(query.filters.file)) {
                continue;
            }

            for (const symbol of symbols) {
                if (!SUPPORTED_SEED_TYPES.has(symbol.type)) {
                    continue;
                }
                if (query.filters.type && !query.filters.type.includes(symbol.type)) {
                    continue;
                }
                const match = this.scoreMatch(symbol.name, query.terms);
                if (match.score <= 0) {
                    continue;
                }

                candidates.push({
                    filePath,
                    symbol,
                    matchType: match.type,
                    matchScore: match.score
                });
            }
        }

        return candidates
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, Math.max(1, limit));
    }

    private scoreMatch(name: string, terms: string[]): { type: ClusterSeed["matchType"]; score: number } {
        if (terms.length === 0) {
            return { type: "fuzzy", score: 0 };
        }

        const nameLower = name.toLowerCase();
        let bestScore = 0;
        let bestType: ClusterSeed["matchType"] = "fuzzy";

        for (const term of terms) {
            const termLower = term.toLowerCase();
            if (!termLower) continue;

            if (nameLower === termLower && bestScore < 1) {
                bestScore = 1;
                bestType = "exact";
                continue;
            }
            if (nameLower.startsWith(termLower) && bestScore < 0.8) {
                bestScore = 0.8;
                bestType = "prefix";
                continue;
            }
            if (nameLower.includes(termLower) && bestScore < 0.5) {
                bestScore = 0.5;
                bestType = "contains";
                continue;
            }

            const segments = this.splitCamelCase(nameLower);
            if (segments.some(segment => segment.startsWith(termLower)) && bestScore < 0.3) {
                bestScore = 0.3;
                bestType = "fuzzy";
            }
        }

        return { type: bestType, score: bestScore };
    }

    private splitCamelCase(value: string): string[] {
        return value.split(/(?=[A-Z])|_|-/).map(segment => segment.toLowerCase()).filter(Boolean);
    }
}
