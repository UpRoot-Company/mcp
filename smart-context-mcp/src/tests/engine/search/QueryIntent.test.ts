import { QueryIntentDetector } from '../../../engine/search/QueryIntent.js';

describe('QueryIntentDetector', () => {
    let detector: QueryIntentDetector;

    beforeEach(() => {
        detector = new QueryIntentDetector();
    });

    test('should detect symbol intent', () => {
        expect(detector.detect('class User')).toBe('symbol');
        expect(detector.detect('interface Config')).toBe('symbol');
        expect(detector.detect('function start')).toBe('symbol');
    });

    test('should detect file intent', () => {
        expect(detector.detect('tsconfig.json')).toBe('file');
        expect(detector.detect('config file')).toBe('file');
        expect(detector.detect('README.md')).toBe('file');
    });

    test('should detect bug intent', () => {
        expect(detector.detect('fix error')).toBe('bug');
        expect(detector.detect('bug in login')).toBe('bug');
        expect(detector.detect('check validation')).toBe('bug');
    });

    test('should return code intent by default', () => {
        expect(detector.detect('auth logic')).toBe('code');
        expect(detector.detect('user management')).toBe('code');
    });
});
