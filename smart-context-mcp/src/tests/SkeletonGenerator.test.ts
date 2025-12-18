import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { AstManager } from '../ast/AstManager.js';
import { SymbolInfo, DefinitionSymbol, ImportSymbol, ExportSymbol } from '../types.js';

describe('SkeletonGenerator', () => {
    let generator: SkeletonGenerator;

    beforeAll(async () => {
        await AstManager.getInstance().init();
        generator = new SkeletonGenerator();
    });

    it('should fold TypeScript function bodies', async () => {
        const code = `
        function add(a: number, b: number): number {
            return a + b;
        }
        `;
        const skeleton = await generator.generateSkeleton('test.ts', code);
        expect(skeleton).toContain('function add(a: number, b: number): number { /* ... implementation hidden ... */ }');
        expect(skeleton).not.toContain('return a + b');
    });

    it('should fold TypeScript method bodies but keep class structure', async () => {
        const code = `
        class MyClass {
            method(): void {
                console.log('body');
            }
        }
        `;
        const skeleton = await generator.generateSkeleton('test.ts', code);
        expect(skeleton).toContain('class MyClass {');
        expect(skeleton).toContain('method(): void { /* ... implementation hidden ... */ }');
        expect(skeleton).not.toContain("console.log('body')");
    });

    it('should fold nested blocks correctly (top-level fold hides inner)', async () => {
        const code = `
        function outer() {
            if (true) {
                console.log('inner');
            }
        }
        `;
        const skeleton = await generator.generateSkeleton('test.ts', code);
        // Should become: function outer() { ... }
        expect(skeleton).toContain('function outer() { /* ... implementation hidden ... */ }');
        expect(skeleton).not.toContain('if (true)');
    });

    it('should not fold object literals', async () => {
        const code = `
        const config = {
            key: 'value'
        };
        `;
        const skeleton = await generator.generateSkeleton('test.ts', code);
        expect(skeleton).toContain('key: \'value\'');
    });

        it('should fold Python function bodies but keep classes', async () => {
        const code = `
class MyClass:
    def method(self):
        print(\"line 1\")
        print(\"line 2\")
        print(\"line 3\")

def global_func():
    print(\"global 1\")
    print(\"global 2\")
    print(\"global 3\")
`;

        const skeleton = await generator.generateSkeleton('test.py', code);
        
        expect(skeleton).toContain('class MyClass:');
        expect(skeleton).toContain('def method(self):');
        expect(skeleton).toContain('...');
        expect(skeleton).not.toContain('print("hello")');
        expect(skeleton).not.toContain('return 1');
    });

    it('includes comments when requested', async () => {
        const code = `
        // headline
        function demo() {
            return true;
        }
        `;
        const withoutComments = await generator.generateSkeleton('test.ts', code);
        expect(withoutComments).not.toContain('// headline');
        const withComments = await generator.generateSkeleton('test.ts', code, { includeComments: true });
        expect(withComments).toContain('// headline');
    });

    it('omits member variables when includeMemberVars is false', async () => {
        const code = `
        class User {
            public id: number;
            public name: string;
            getId() {
                return this.id;
            }
        }
        `;
        const skeleton = await generator.generateSkeleton('test.ts', code, { includeMemberVars: false });
        expect(skeleton).not.toMatch(/public id/);
        expect(skeleton).toContain('getId()');
    });

    it('expands short bodies in detailed detailLevel', async () => {
        const code = `
        function sum(a: number, b: number): number {
            return a + b;
        }
        `;
        const detailed = await generator.generateSkeleton('test.ts', code, { detailLevel: "detailed" });
        expect(detailed).toContain('return a + b');
        const standard = await generator.generateSkeleton('test.ts', code);
        expect(standard).not.toContain('return a + b');
    });

    it('respects maxMemberPreview when showing arrays', async () => {
        const code = `
        class User {
            public fields = ['id', 'name', 'email', 'status'];
        }
        `;
        const skeleton = await generator.generateSkeleton('test.ts', code, { maxMemberPreview: 2 });
        expect(skeleton).toContain("['id', 'name', ...2 more]");
    });

    it('produces minimal summaries when detailLevel is minimal', async () => {
        const code = `
        class User {
            public id: number;
            constructor() {
                this.id = 0;
            }
            greet() {
                return 'hello';
            }
        }
        `;
        const skeleton = await generator.generateSkeleton('test.ts', code, { detailLevel: "minimal", includeMemberVars: false });
        const lines = skeleton.split('\n').map(line => line.trim()).filter(Boolean);
        expect(lines.every(line => /(class|constructor|greet)/.test(line))).toBe(true);
    });

    describe('generateStructureJson', () => {
        it('should extract TypeScript class and method symbols correctly', async () => {
            const code = `
            class MyClass {
                private static instance: MyClass;
                constructor(name: string) { /* ... */ }
                public async fetchData(id: string): Promise<any[]> {
                    return [];
                }
                get name(): string { return 'name'; }
            }
            interface MyInterface {
                prop: string;
                method(a: number): boolean;
            }
            `;
            const symbols = await generator.generateStructureJson('test.ts', code);
            
            expect(symbols).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: 'class',
                    name: 'MyClass',
                    range: expect.any(Object),
                }),
                expect.objectContaining({
                    type: 'method',
                    name: 'constructor',
                    container: 'MyClass',
                    parameters: ['name'],
                }),
                expect.objectContaining({
                    type: 'method',
                    name: 'fetchData',
                    container: 'MyClass',
                    parameters: ['id'],
                    returnType: ': Promise<any[]>',
                }),
                expect.objectContaining({
                    type: 'method',
                    name: 'name',
                    container: 'MyClass',
                    returnType: ': string',
                }),
                expect.objectContaining({
                    type: 'interface',
                    name: 'MyInterface',
                    range: expect.any(Object),
                }),
            ]));

            const fetchDataSymbol = symbols.find((s: SymbolInfo) => s.name === 'fetchData');
            expect((fetchDataSymbol as DefinitionSymbol)?.signature).toMatch(/^public async fetchData\(id: string\): Promise<any\[\]>/);
        });

        it('should extract TypeScript function and variable symbols correctly', async () => {
            const code = `
            const myVar: number = 10;
            function processData(data: string): void {
                console.log(data);
            }
            export default function handler() { return 1; }
            `;
            const symbols = await generator.generateStructureJson('test.ts', code);

            expect(symbols).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: 'variable',
                    name: 'myVar',
                    range: expect.any(Object),
                }),
                expect.objectContaining({
                    type: 'function',
                    name: 'processData',
                    parameters: ['data'],
                    returnType: ': void',
                }),
                expect.objectContaining({
                    type: 'function',
                    name: 'handler',
                }),
            ]));
            const processDataSymbol = symbols.find((s: SymbolInfo) => s.name === 'processData');
            expect((processDataSymbol as DefinitionSymbol)?.signature).toMatch(/^function processData\(data: string\): void/);
        });

        it('should extract Python class and function symbols correctly', async () => {
            const code = `
class PythonClass:
    def __init__(self, name):
        self.name = name

def python_func(arg1, arg2):
    return arg1 + arg2
            `;
            const symbols = await generator.generateStructureJson('test.py', code);
            
            expect(symbols).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: 'class',
                    name: 'PythonClass',
                    range: expect.any(Object),
                }),
                expect.objectContaining({
                    type: 'function',
                    name: '__init__',
                    container: 'PythonClass',
                    parameters: ['self', 'name'],
                }),
                expect.objectContaining({
                    type: 'function',
                    name: 'python_func',
                    parameters: ['arg1', 'arg2'],
                }),
            ]));

            const pythonFuncSymbol = symbols.find((s: SymbolInfo) => s.name === 'python_func');
            expect((pythonFuncSymbol as DefinitionSymbol)?.signature).toMatch(/^def python_func\(arg1, arg2\)/);
        });

        it('should return empty array for unsupported language', async () => {
            const symbols = await generator.generateStructureJson('unsupported.xyz', 'some content');
            expect(symbols).toEqual([]);
        });

        it('should return empty array for empty content', async () => {
            const symbols = await generator.generateStructureJson('test.ts', '');
            expect(symbols).toEqual([]);
        });

        it('should extract TypeScript imports correctly', async () => {
            const code = `
            import { a, b as c } from 'd';
            import * as ns from 'e';
            import f from 'f';
            import 'g';
            `;
            const symbols = await generator.generateStructureJson('test.ts', code);
            const imports = symbols.filter((s: SymbolInfo) => s.type === 'import') as ImportSymbol[];
            
            expect(imports).toHaveLength(4);
            
            const named = imports.find(s => s.source === 'd');
            expect(named).toBeDefined();
            expect(named!.importKind).toBe('named');
            expect(named!.imports).toEqual([{ name: 'a', alias: undefined }, { name: 'b', alias: 'c' }]);
            
            const namespace = imports.find(s => s.source === 'e');
            expect(namespace).toBeDefined();
            expect(namespace!.importKind).toBe('namespace');
            expect(namespace!.alias).toBe('ns');
            
            const def = imports.find(s => s.source === 'f');
            expect(def).toBeDefined();
            expect(def!.importKind).toBe('default');
            expect(def!.alias).toBe('f');
            
            const sideEffect = imports.find(s => s.source === 'g');
            expect(sideEffect).toBeDefined();
            expect(sideEffect!.importKind).toBe('side-effect');
        });

        it('should extract TypeScript exports correctly', async () => {
            const code = `
            export { a } from 'b';
            export * from 'c';
            export const d = 1;
            `;
            const symbols = await generator.generateStructureJson('test.ts', code);
            const exports = symbols.filter((s: SymbolInfo) => s.type === 'export') as ExportSymbol[];
            
            expect(exports).toHaveLength(3); // Updated to 3 (Local export d is now captured)
            
            const named = exports.find(s => s.source === 'b');
            expect(named).toBeDefined();
            expect(named!.exportKind).toBe('re-export');
            expect(named!.exports).toEqual([{ name: 'a', alias: undefined }]);
            
            const star = exports.find(s => s.source === 'c');
            expect(star).toBeDefined();
            expect(star!.exportKind).toBe('re-export');
            expect(star!.name).toContain('*');
            
            const local = exports.find(s => s.name === 'local exports');
            expect(local).toBeDefined();
            expect(local!.exportKind).toBe('named');
            expect(local!.exports).toEqual([{ name: 'd' }]);
        });

        it('should extract local named exports correctly', async () => {
            const code = `
                export const value = 42;
                export function helper() {}
                export class Service {}
            `;
            const symbols = await generator.generateStructureJson('test.ts', code);
            const exports = symbols.filter((s: SymbolInfo) => s.type === 'export') as ExportSymbol[];
            
            expect(exports).toHaveLength(3);
            const val = exports.find(e => e.exports?.some((x: { name: string; }) => x.name === 'value'));
            expect(val).toBeDefined();
            expect(val!.exportKind).toBe('named');
            
            const func = exports.find(e => e.exports?.some((x: { name: string; }) => x.name === 'helper'));
            expect(func).toBeDefined();
            
            const cls = exports.find(e => e.exports?.some((x: { name: string; }) => x.name === 'Service'));
            expect(cls).toBeDefined();
        });

        it('should extract default exports correctly', async () => {
            const code = `export default class MyClass {}`;
            const symbols = await generator.generateStructureJson('test.ts', code);
            const defaultExport = symbols.find((s: SymbolInfo) => 
                s.type === 'export' && (s as ExportSymbol).exportKind === 'default'
            ) as ExportSymbol;
            expect(defaultExport).toBeDefined();
            expect(defaultExport.name).toBe('MyClass');
        });

        it('should detect type-only imports', async () => {
            const code = `import type { User } from './types';`;
            const symbols = await generator.generateStructureJson('test.ts', code);
            const typeImport = symbols.find((s: SymbolInfo) => 
                s.type === 'import' && (s as ImportSymbol).isTypeOnly
            );
            expect(typeImport).toBeDefined();
        });
    });

    describe('Tier 2: Semantic Summaries', () => {
        it('should include semantic summary when includeSummary is true', async () => {
            const code = `
            class Service {
                async save() {
                    const data = await db.users.insert({ name: 'test' });
                    logger.info('Saved');
                    return data;
                }
            }
            `;
            const skeleton = await generator.generateSkeleton('test.ts', code, { includeSummary: true });
            expect(skeleton).toContain('implementation hidden');
            expect(skeleton).toContain('calls: db.users.insert, logger.info');
        });
    });
});
