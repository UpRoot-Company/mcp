
import { QueryIntent } from '../search/QueryIntent.js';

export interface WeightProfile {
    trigram: number;
    filename: number;
    symbol: number;
    comment: number;
    testCoverage: number;
    recency: number;
    outboundImportance: number;
}

export class AdaptiveWeights {
    private profiles: Record<QueryIntent, WeightProfile> = {
        symbol: {
            trigram: 0.15, filename: 0.10, symbol: 0.40, comment: 0.10,
            testCoverage: 0.10, recency: 0.05, outboundImportance: 0.10
        },
        file: {
            trigram: 0.10, filename: 0.50, symbol: 0.05, comment: 0.05,
            testCoverage: 0.05, recency: 0.15, outboundImportance: 0.10
        },
        code: {
            trigram: 0.30, filename: 0.15, symbol: 0.20, comment: 0.15,
            testCoverage: 0.05, recency: 0.05, outboundImportance: 0.10
        },
        bug: {
            trigram: 0.20, filename: 0.10, symbol: 0.15, comment: 0.30,
            testCoverage: 0.15, recency: 0.05, outboundImportance: 0.05
        }
    };

    getWeights(intent: QueryIntent): WeightProfile {
        return this.profiles[intent];
    }
}
