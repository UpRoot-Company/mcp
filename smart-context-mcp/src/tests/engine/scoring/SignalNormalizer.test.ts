import { SignalNormalizer, FileContext } from '../../../engine/scoring/SignalNormalizer.js';

describe('SignalNormalizer', () => {
    let normalizer: SignalNormalizer;
    const context: FileContext = { lineCount: 100 };

    beforeEach(() => {
        normalizer = new SignalNormalizer();
    });

    test('should normalize trigram score', () => {
        expect(normalizer.normalize(0, 'trigram', context)).toBe(0);
        expect(normalizer.normalize(50, 'trigram', context)).toBe(0.5);
        expect(normalizer.normalize(100, 'trigram', context)).toBe(1.0);
        expect(normalizer.normalize(200, 'trigram', context)).toBe(1.0);
    });

    test('should normalize filename score', () => {
        expect(normalizer.normalize(50, 'filename', context)).toBe(0.5);
        expect(normalizer.normalize(100, 'filename', context)).toBe(1.0);
    });

    test('should apply penalty for very large files', () => {
        const largeContext = { lineCount: 2000 };
        const score = normalizer.normalize(100, 'trigram', context); // 1.0
        const largeScore = normalizer.normalize(100, 'trigram', largeContext); // 1.0 * 0.9 = 0.9
        expect(largeScore).toBeLessThan(score);
        expect(largeScore).toBeCloseTo(0.9);
    });
});
