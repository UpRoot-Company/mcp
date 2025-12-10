import { SymbolIndex } from "../../ast/SymbolIndex.js";
import { DependencyGraph } from "../../ast/DependencyGraph.js";
import { SymbolInfo } from "../../types.js";

export interface HotSpotConfig {
    minIncomingRefs: number;
    trackEntryExports: boolean;
    patternMatchers: RegExp[];
    maxHotSpots: number;
}

export interface HotSpot {
    filePath: string;
    symbol: SymbolInfo;
    score: number;
    reasons: string[];
}

const DEFAULT_HOT_SPOT_CONFIG: HotSpotConfig = {
    minIncomingRefs: 5,
    trackEntryExports: true,
    patternMatchers: [
        /^(get|set|create|update|delete|handle|process)/i,
        /Service$/,
        /Controller$/,
        /^use[A-Z]/
    ],
    maxHotSpots: 30
};

export class HotSpotDetector {
    constructor(
        private readonly symbolIndex: SymbolIndex,
        private readonly dependencyGraph: DependencyGraph,
        private readonly config: HotSpotConfig = DEFAULT_HOT_SPOT_CONFIG
    ) {}

    async detectHotSpots(): Promise<HotSpot[]> {
        const allSymbols = await this.symbolIndex.getAllSymbols();
        const candidates: HotSpot[] = [];

        for (const [filePath, symbols] of allSymbols) {
            for (const symbol of symbols) {
                if (symbol.type === "import" || symbol.type === "export") {
                    continue;
                }
                const score = await this.scoreSymbol(filePath, symbol).catch(() => 0);
                if (score <= 0) {
                    continue;
                }
                candidates.push({
                    filePath,
                    symbol,
                    score,
                    reasons: this.explainScore(filePath, symbol, score)
                });
            }
        }

        return candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, this.config.maxHotSpots);
    }

    private async scoreSymbol(filePath: string, symbol: SymbolInfo): Promise<number> {
        let score = 0;

        try {
            const incoming = await this.dependencyGraph.getDependencies(filePath, "incoming");
            if (incoming.length >= this.config.minIncomingRefs) {
                score += Math.min(incoming.length / 2, 10);
            }
        } catch {
            // Dependency data may be stale; ignore failures but keep scoring.
        }

        if (this.config.patternMatchers.some(pattern => pattern.test(symbol.name))) {
            score += 3;
        }

        if (this.config.trackEntryExports && this.isEntryPointExport(filePath, symbol)) {
            score += 5;
        }

        if (symbol.type === "class" || symbol.type === "interface") {
            score += 2;
        }

        return score;
    }

    private isEntryPointExport(filePath: string, symbol: SymbolInfo): boolean {
        const isIndex = /(?:^|\/)index\.(ts|js)x?$/.test(filePath);
        const hasExportModifier = symbol.modifiers?.includes("export");
        return isIndex && (hasExportModifier || symbol.type === "export");
    }

    private explainScore(filePath: string, symbol: SymbolInfo, score: number): string[] {
        const reasons: string[] = [];
        if (score >= 5 && this.isEntryPointExport(filePath, symbol)) {
            reasons.push("entry_export");
        }
        if (this.config.patternMatchers.some(pattern => pattern.test(symbol.name))) {
            reasons.push("pattern_match");
        }
        return reasons;
    }
}
