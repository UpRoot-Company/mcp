export interface FileContext {
    lineCount: number;
}

export class SignalNormalizer {
    /**
     * Ranges for normalizing raw signals to 0.0 - 1.0.
     */
    private ranges: Record<string, number> = {
        trigram: 100, // BM25 scores can be large, use 100 to allow room
        filename: 100,
        symbol: 100,
        comment: 100,
        testCoverage: 1,
        recency: 1,
        outboundImportance: 1
    };

    /**
     * Normalizes a raw signal score based on its type and file context.
     */
    public normalize(score: number, type: string, context: FileContext): number {
        const range = this.ranges[type] || 100;
        
        // Use a linear normalization within range, capped at 1.0
        let normalized = Math.min(1.0, Math.max(0, score / range));

        // Penalty based on file size for content matches
        if (type === 'trigram' && context.lineCount > 1000) {
            normalized *= 0.9;
        }

        return normalized;
    }
}
