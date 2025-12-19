import { CallSiteAnalyzer } from '../../../ast/analysis/CallSiteAnalyzer.js';
import { AstManager } from '../../../ast/AstManager.js';
import { DefinitionSymbol } from '../../../types.js';

describe('CallSiteAnalyzer', () => {
    let analyzer: CallSiteAnalyzer;
    let astManager: AstManager;

    beforeAll(async () => {
        astManager = AstManager.getInstance();
        await astManager.init();
        analyzer = new CallSiteAnalyzer();
    });

    test('should identify function calls', async () => {
        const code = `
            function target() {}
            function caller() {
                target();
            }
        `;
        
        const doc = await astManager.parseFile('test.ts', code);
        const lang = await astManager.getLanguageForFile('test.ts');
        
        // Mock definition map - we need to manually create the DefinitionSymbol for 'caller'
        // and map it to the AST node range for caller() definition.
        // For simplicity in this unit test, we can just check if it finds the call
        // if we provide a dummy map that covers the whole file or specific range.
        
        // However, CallSiteAnalyzer relies on finding an "owner" definition for the call site.
        // "target();" is inside "caller()". So we need a DefinitionSymbol for "caller".
        
        // Let's manually find the "caller" node to make a key.
        const root = doc.rootNode;
        const callerNode = root.descendantsOfType('function_declaration').find((n: any) => n.childForFieldName('name')?.text === 'caller');
        
        expect(callerNode).toBeDefined();

        const callerSymbol: DefinitionSymbol = {
            name: 'caller',
            type: 'function',
            range: { 
                startLine: callerNode.startPosition.row, 
                endLine: callerNode.endPosition.row,
                startByte: callerNode.startIndex,
                endByte: callerNode.endIndex
            },
            calls: []
        };

        const key = `${callerNode.id}:${callerNode.startIndex}:${callerNode.endIndex}`;
        const map = new Map<string, DefinitionSymbol>();
        map.set(key, callerSymbol);

        analyzer.attachCallSiteMetadata(root, lang, 'typescript', map);

        expect(callerSymbol.calls).toHaveLength(1);
        expect(callerSymbol.calls![0].calleeName).toBe('target');
        expect(callerSymbol.calls![0].callType).toBe('direct');
    });
});
