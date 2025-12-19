import { FilenameScorer } from '../../../engine/scoring/FilenameScorer.js';

describe('FilenameScorer', () => {
    let scorer: FilenameScorer;

    beforeEach(() => {
        scorer = new FilenameScorer();
    });

    test('should score exact matches highly', () => {
        const score = scorer.calculateFilenameScore('src/User.ts', 'User', { fuzzy: false, basenameOnly: true });
        expect(score).toBeGreaterThan(0);
    });

    test('should handle fuzzy matching', () => {
        const score = scorer.calculateFilenameScore('src/UserService.ts', 'UserService', { fuzzy: true, basenameOnly: true });
        expect(score).toBeGreaterThan(0);
    });
});
