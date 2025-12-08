
import { Document } from "../types.js";

export class BM25Ranking {
    private k1: number;
    private b: number;

    constructor(k1: number = 1.2, b: number = 0.75) {
        this.k1 = k1;
        this.b = b;
    }

    public rank(documents: Document[], query: string): Document[] {
        if (documents.length === 0) return [];

        const tokenizedDocs = documents.map(doc => ({
            id: doc.id,
            originalText: doc.text,
            tokens: this.tokenize(doc.text),
            score: 0
        }));

        const avgdl = tokenizedDocs.reduce((sum, doc) => sum + doc.tokens.length, 0) / tokenizedDocs.length;
        const queryTokens = this.tokenize(query);
        const idfMap = new Map<string, number>();

        queryTokens.forEach(term => {
            const docFreq = tokenizedDocs.filter(doc => doc.tokens.includes(term)).length;
            const idf = Math.log(((tokenizedDocs.length - docFreq + 0.5) / (docFreq + 0.5)) + 1);
            idfMap.set(term, idf);
        });

        tokenizedDocs.forEach(doc => {
            let docScore = 0;
            const docLength = doc.tokens.length;
            queryTokens.forEach(term => {
                const tf = doc.tokens.filter(t => t === term).length;
                if (tf > 0) {
                    const idf = idfMap.get(term) || 0;
                    const numerator = tf * (this.k1 + 1);
                    const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / avgdl));
                    docScore += idf * (numerator / denominator);
                }
            });
            const originalDoc = documents.find(originalDoc => originalDoc.id === doc.id);
            if (originalDoc) {
                originalDoc.score = docScore;
            }
        });

        return documents.sort((a, b) => b.score - a.score);
    }

    private tokenize(text: string): string[] {
        return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0);
    }
}
