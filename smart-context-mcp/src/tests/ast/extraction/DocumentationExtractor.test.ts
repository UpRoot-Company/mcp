import { DocumentationExtractor } from '../../../ast/extraction/DocumentationExtractor.js';
import { AstManager } from '../../../ast/AstManager.js';

describe('DocumentationExtractor', () => {
    let extractor: DocumentationExtractor;
    let astManager: AstManager;

    beforeAll(async () => {
        astManager = AstManager.getInstance();
        await astManager.init();
        extractor = new DocumentationExtractor();
    });

    test('should extract JSDoc comments', async () => {
        const code = `
            /**
             * Calculates sum
             * @param a First number
             */
            function add(a: number, b: number) {}
        `;
        const doc = await astManager.parseFile('test.ts', code);
        const funcNode = doc.rootNode.descendantsOfType('function_declaration')[0];
        
        const documentation = extractor.extractDocumentation(funcNode, 'typescript');
        expect(documentation).toContain('Calculates sum');
        expect(documentation).toContain('@param a');
    });

    test('should extract parameter names', async () => {
        const code = `function test(a: string, b: number = 1, ...args: any[]) {}`;
        const doc = await astManager.parseFile('test.ts', code);
        const funcNode = doc.rootNode.descendantsOfType('function_declaration')[0];
        
        const params = extractor.extractParameterNames(funcNode);
        expect(params).toEqual(['a', 'b', '...args']);
    });

    test('should extract return type', async () => {
        const code = `function test(): string { return ""; }`;
        const doc = await astManager.parseFile('test.ts', code);
        const funcNode = doc.rootNode.descendantsOfType('function_declaration')[0];
        
        const returnType = extractor.extractReturnType(funcNode);
        expect(returnType).toBe(': string');
    });
});
