
import * as path from "path";
import { Document, ScoreDetails, SearchFieldType } from "../types.js";

const DEFAULT_FIELD_WEIGHTS: Record<SearchFieldType, number> = {
    "symbol-definition": 10,
    "signature": 6,
    "exported-member": 3,
    "comment": 0.5,
    "code-body": 1,
};

export interface BM25FConfig {
    k1?: number;
    b?: number;
    fieldWeights?: Partial<Record<SearchFieldType, number>>;
}

export class BM25FRanking {
    private readonly k1: number;
    private readonly b: number;
    private readonly fieldWeights: Record<SearchFieldType, number>;

    constructor(config: BM25FConfig = {}) {
        this.k1 = config.k1 ?? 1.2;
        this.b = config.b ?? 0.75;
        this.fieldWeights = {
            ...DEFAULT_FIELD_WEIGHTS,
            ...(config.fieldWeights ?? {})
        };
    }

    public rank(documents: Document[], query: string): Document[] {
        if (documents.length === 0) return [];

        const tokenizedDocs = documents.map(doc => ({
            id: doc.id,
            tokens: this.tokenize(doc.text)
        }));

        const avgdl = tokenizedDocs.reduce((sum, doc) => sum + doc.tokens.length, 0) / tokenizedDocs.length;
        const queryTokens = this.tokenize(query);
        const idfMap = new Map<string, number>();

        queryTokens.forEach(term => {
            const docFreq = tokenizedDocs.filter(doc => doc.tokens.includes(term)).length;
            const idf = Math.log(((tokenizedDocs.length - docFreq + 0.5) / (docFreq + 0.5)) + 1);
            idfMap.set(term, idf);
        });

        const contentScores = new Map<string, number>();
        tokenizedDocs.forEach(doc => {
            let docScore = 0;
            const docLength = doc.tokens.length || 1;
            queryTokens.forEach(term => {
                const tf = doc.tokens.filter(t => t === term).length;
                if (tf > 0) {
                    const idf = idfMap.get(term) || 0;
                    const numerator = tf * (this.k1 + 1);
                    const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / avgdl));
                    docScore += idf * (numerator / denominator);
                }
            });
            contentScores.set(doc.id, docScore);
        });

        const rankedDocuments = documents.map(doc => {
            const contentScore = contentScores.get(doc.id) ?? 0;
            const derivedFilePath = doc.filePath ?? this.extractFilePathFromId(doc.id);
            const filenameImpact = this.calculateFilenameMultiplier(derivedFilePath, queryTokens);
            const depthMultiplier = this.calculateDepthMultiplier(derivedFilePath);
            const fieldType = doc.fieldType ?? "code-body";
            const fieldWeight = this.fieldWeights[fieldType] ?? 1;
            const totalScore = contentScore * filenameImpact.multiplier * depthMultiplier * fieldWeight;
            const details: ScoreDetails = {
                contentScore,
                filenameMultiplier: filenameImpact.multiplier,
                depthMultiplier,
                fieldWeight,
                totalScore,
                filenameMatchType: filenameImpact.matchType,
                fieldType
            };
            doc.score = totalScore;
            doc.filePath = derivedFilePath ?? doc.filePath;
            doc.scoreDetails = details;
            return doc;
        });

        return rankedDocuments.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    private tokenize(text: string): string[] {
        return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0);
    }

    private extractFilePathFromId(id: string): string | undefined {
        if (!id.includes(':')) {
            return id;
        }
        const lastColon = id.lastIndexOf(':');
        if (lastColon === -1) {
            return id;
        }
        return id.slice(0, lastColon);
    }

    private calculateFilenameMultiplier(filePath: string | undefined, queryTokens: string[]): { multiplier: number; matchType: "exact" | "partial" | "none" } {
        if (!filePath || queryTokens.length === 0) {
            return { multiplier: 1, matchType: "none" };
        }
        const baseName = path.basename(filePath).toLowerCase();
        const trimmedBase = baseName.startsWith('.') ? baseName.slice(1) : baseName;
        const ext = path.extname(trimmedBase);
        const stem = ext ? trimmedBase.slice(0, -ext.length) : trimmedBase;
        let multiplier = 1;
        let matchType: "exact" | "partial" | "none" = "none";

        for (const token of queryTokens) {
            const normalizedToken = token.toLowerCase();
            if (!normalizedToken) {
                continue;
            }
            const isExactMatch = stem === normalizedToken || trimmedBase === normalizedToken || baseName === normalizedToken;
            if (isExactMatch) {
                multiplier = 10;
                matchType = "exact";
                break;
            }
            const isSubstring = stem.includes(normalizedToken) || trimmedBase.includes(normalizedToken) || baseName.includes(normalizedToken);
            if (isSubstring) {
                multiplier = Math.max(multiplier, 5);
                matchType = "partial";
            }
        }

        return { multiplier, matchType };
    }

    private calculateDepthMultiplier(filePath: string | undefined): number {
        if (!filePath) {
            return 1;
        }
        const normalizedSegments = filePath.split(/[\\/]/).filter(segment => segment.length > 0);
        const depth = Math.max(normalizedSegments.length - 1, 0);
        return 1 / (depth + 1);
    }
}
