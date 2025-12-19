import { AdaptiveWeights } from '../../../engine/scoring/AdaptiveWeights.js';

describe('AdaptiveWeights', () => {
    let adaptiveWeights: AdaptiveWeights;

    beforeEach(() => {
        adaptiveWeights = new AdaptiveWeights();
    });

    test('should return correct weights for symbol intent', () => {
        const weights = adaptiveWeights.getWeights('symbol');
        expect(weights.symbol).toBeGreaterThan(weights.filename);
        expect(weights.symbol).toBe(0.40);
    });

    test('should return correct weights for file intent', () => {
        const weights = adaptiveWeights.getWeights('file');
        expect(weights.filename).toBeGreaterThan(weights.symbol);
        expect(weights.filename).toBe(0.50);
    });

    test('should return correct weights for code intent', () => {
        const weights = adaptiveWeights.getWeights('code');
        expect(weights.trigram).toBeGreaterThan(weights.filename);
        expect(weights.trigram).toBe(0.30);
    });

    test('should return correct weights for bug intent', () => {
        const weights = adaptiveWeights.getWeights('bug');
        expect(weights.comment).toBeGreaterThan(weights.filename);
        expect(weights.comment).toBe(0.30);
    });
});
