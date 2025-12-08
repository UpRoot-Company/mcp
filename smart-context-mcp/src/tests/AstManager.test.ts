import { AstManager } from '../ast/AstManager.js';

describe('AstManager', () => {
    let astManager: AstManager;

    beforeAll(async () => {
        astManager = AstManager.getInstance();
        await astManager.init();
    });

    it('should be a singleton', () => {
        const instance1 = AstManager.getInstance();
        const instance2 = AstManager.getInstance();
        expect(instance1).toBe(instance2);
    });

    it('should return a parser for TypeScript files', async () => {
        const parser = await astManager.getParserForFile('test.ts');
        expect(parser).toBeDefined();
        
        const tree = parser.parse('const x: number = 1;');
        expect(tree.rootNode.type).toBe('program');
        expect(tree.rootNode.text).toBe('const x: number = 1;');
    });

    it('should return a parser for JavaScript files', async () => {
        const parser = await astManager.getParserForFile('script.js');
        expect(parser).toBeDefined();
        
        const tree = parser.parse('function hello() { return "world"; }');
        expect(tree.rootNode.type).toBe('program');
    });

    it('should return a parser for Python files', async () => {
        const parser = await astManager.getParserForFile('script.py');
        expect(parser).toBeDefined();
        
        const tree = parser.parse('def hello():\n    print("world")');
        expect(tree.rootNode.type).toBe('module'); // Python root is 'module'
    });

    it('should return null for unsupported extensions', async () => {
        const parser = await astManager.getParserForFile('image.png');
        expect(parser).toBeNull();
    });

    it('should handle different TypeScript extensions (.tsx)', async () => {
        const parser = await astManager.getParserForFile('component.tsx');
        expect(parser).toBeDefined();
        
        // Simple JSX check
        const tree = parser.parse('const el = <div>Hello</div>;');
        expect(tree.rootNode.text).toBe('const el = <div>Hello</div>;');
    });
});
