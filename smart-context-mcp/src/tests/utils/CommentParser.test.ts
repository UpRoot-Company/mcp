import { CommentParser } from '../../utils/CommentParser.js';

describe('CommentParser', () => {
    let parser: CommentParser;

    beforeEach(() => {
        parser = new CommentParser();
    });

    test('should identify comment lines', () => {
        expect(parser.isCommentLine('// This is a comment')).toBe(true);
        expect(parser.isCommentLine('/* Multi-line start')).toBe(true);
        expect(parser.isCommentLine(' * continuation')).toBe(true);
        expect(parser.isCommentLine('const x = 1;')).toBe(false);
    });

    test('should extract comments from TS/JS', () => {
        const content = `
            // Line comment
            const x = 1;
            /* Block comment */
        `;
        const comments = parser.extractComments(content, 'test.ts');
        expect(comments).toContain('Line comment');
        expect(comments).toContain('Block comment');
    });
});
