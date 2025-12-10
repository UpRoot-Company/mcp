import path from "path";
import { promises as fs } from "fs";
import { DefinitionSymbol, SymbolInfo } from "../../types.js";
import { PREVIEW_TIERS, RelatedSymbol, SearchCluster } from "../../types/cluster.js";

const TOKEN_TO_CHAR_MULTIPLIER = 4;

export class PreviewGenerator {
    constructor(private readonly rootPath: string) {}

    async applyPreviews(clusters: SearchCluster[]): Promise<void> {
        const contentCache = new Map<string, string>();
        const readContent = async (filePath: string): Promise<string> => {
            if (contentCache.has(filePath)) {
                return contentCache.get(filePath)!;
            }
            const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
            try {
                const content = await fs.readFile(absPath, "utf8");
                contentCache.set(filePath, content);
                return content;
            } catch {
                contentCache.set(filePath, "");
                return "";
            }
        };

        for (const cluster of clusters) {
            for (const seed of cluster.seeds) {
                const body = seed.symbol.content ?? (await readContent(seed.filePath));
                seed.fullPreview = this.generateSeedPreview(seed.symbol, body);
            }

            this.applySignaturePreviews(cluster.related.callers.data);
            this.applySignaturePreviews(cluster.related.callees.data);
            this.applySignaturePreviews(cluster.related.typeFamily.data);
            this.applyMinimalPreviews(cluster.related.colocated.data);
            this.applyMinimalPreviews(cluster.related.siblings.data);
        }
    }

    private generateSeedPreview(symbol: SymbolInfo, content: string): string {
        const budget = PREVIEW_TIERS.full;
        const definition = symbol as Partial<DefinitionSymbol>;
        const base = definition.signature || content || symbol.name;
        return this.truncate(base, budget.maxTokens);
    }

    private applySignaturePreviews(symbols: RelatedSymbol[]): void {
        for (const symbol of symbols) {
            symbol.signature = symbol.signature || `${symbol.symbolName} (${symbol.symbolType})`;
        }
    }

    private applyMinimalPreviews(symbols: RelatedSymbol[]): void {
        for (const symbol of symbols) {
            symbol.minimalPreview = symbol.minimalPreview || `${symbol.symbolName} (${symbol.symbolType})`;
        }
    }

    private truncate(text: string, maxTokens: number): string {
        if (!text) return "";
        const maxChars = maxTokens * TOKEN_TO_CHAR_MULTIPLIER;
        if (text.length <= maxChars) {
            return text.trim();
        }
        return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
    }
}
