import { describe, it, expect } from '@jest/globals';
import { AstDiffEngine } from '../../ast/AstDiffEngine.js';

describe('AstDiffEngine', () => {
    const engine = new AstDiffEngine();

    describe('Function Changes', () => {
        it('should detect function removal', async () => {
            const oldCode = `
export function calculateTotal(a: number, b: number): number {
    return a + b;
}
            `;
            
            const newCode = `
// Function removed
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            expect(result.changes.length).toBeGreaterThan(0);
            expect(result.hasBreakingChanges).toBe(true);
            expect(result.affectedSymbols.has('calculateTotal')).toBe(true);
            
            const removal = result.changes.find(c => c.type === 'remove');
            expect(removal).toBeDefined();
            expect(removal?.symbolName).toBe('calculateTotal');
            expect(removal?.isBreaking).toBe(true);
        });

        it('should detect function addition', async () => {
            const oldCode = `
export function existing() {}
            `;
            
            const newCode = `
export function existing() {}

export function newFunction(x: string): void {
    console.log(x);
}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const addition = result.changes.find(c => c.type === 'add');
            expect(addition).toBeDefined();
            expect(addition?.symbolName).toBe('newFunction');
            expect(addition?.isBreaking).toBe(false);
        });

        it('should detect signature changes', async () => {
            const oldCode = `
export function process(data: string): void {
    console.log(data);
}
            `;
            
            const newCode = `
export function process(data: string, options: any): void {
    console.log(data, options);
}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            expect(result.hasBreakingChanges).toBe(true);
            
            const sigChange = result.changes.find(c => c.type === 'signature-change');
            expect(sigChange).toBeDefined();
            expect(sigChange?.symbolName).toBe('process');
            expect(sigChange?.isBreaking).toBe(true);
        });

        it('should detect parameter addition', async () => {
            const oldCode = `
export function add(a: number, b: number): number {
    return a + b;
}
            `;
            
            const newCode = `
export function add(a: number, b: number, c: number): number {
    return a + b + c;
}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const paramAdd = result.changes.find(c => c.type === 'parameter-add');
            expect(paramAdd).toBeDefined();
            expect(paramAdd?.symbolName).toBe('add');
            expect(paramAdd?.isBreaking).toBe(true);
            expect(paramAdd?.details?.newCount).toBe(3);
            expect(paramAdd?.details?.oldCount).toBe(2);
        });

        it('should detect parameter removal', async () => {
            const oldCode = `
export function multiply(a: number, b: number, c: number): number {
    return a * b * c;
}
            `;
            
            const newCode = `
export function multiply(a: number, b: number): number {
    return a * b;
}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const paramRemove = result.changes.find(c => c.type === 'parameter-remove');
            expect(paramRemove).toBeDefined();
            expect(paramRemove?.symbolName).toBe('multiply');
            expect(paramRemove?.isBreaking).toBe(true);
        });

        it('should detect function with default parameters', async () => {
            const oldCode = `
export function greet(name: string): string {
    return "Hello";
}
            `;
            
            const newCode = `
export function greet(name: string = "World"): string {
    return "Hello";
}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const change = result.changes.find(c => c.symbolName === 'greet');
            expect(change).toBeDefined();
        });

        it('should detect function with rest parameters', async () => {
            const oldCode = `
export function sum(a: number, b: number): number {
    return a + b;
}
            `;
            
            const newCode = `
export function sum(...numbers: number[]): number {
    return numbers.reduce((a, b) => a + b, 0);
}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const change = result.changes.find(c => c.symbolName === 'sum');
            expect(change).toBeDefined();
            expect(change?.isBreaking).toBe(true);
        });

        it('should detect optional parameter addition', async () => {
            const oldCode = `
export function configure(port: number): void {}
            `;
            
            const newCode = `
export function configure(port: number, debug?: boolean): void {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const change = result.changes.find(c => c.symbolName === 'configure');
            expect(change).toBeDefined();
        });
    });

    describe('Class Changes', () => {
        it('should detect class addition', async () => {
            const oldCode = `
export class ExistingClass {}
            `;
            
            const newCode = `
export class ExistingClass {}
export class NewClass {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const addition = result.changes.find(c => c.type === 'add' && c.symbolType === 'class');
            expect(addition).toBeDefined();
            expect(addition?.symbolName).toBe('NewClass');
        });

        it('should detect class removal', async () => {
            const oldCode = `
export class Calculator {}
export class Helper {}
            `;
            
            const newCode = `
export class Calculator {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const removal = result.changes.find(c => c.type === 'remove' && c.symbolType === 'class');
            expect(removal).toBeDefined();
            expect(removal?.symbolName).toBe('Helper');
            expect(removal?.isBreaking).toBe(true);
        });
    });

    describe('Export Pattern Changes', () => {
        it('should detect export removal', async () => {
            const oldCode = `
export function helper() {}
export function util() {}
            `;
            
            const newCode = `
function helper() {}
export function util() {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const removal = result.changes.find(c => c.symbolName === 'helper');
            expect(removal).toBeDefined();
            expect(removal?.isBreaking).toBe(true);
        });

        it('should detect export addition', async () => {
            const oldCode = `
function internal() {}
            `;
            
            const newCode = `
export function internal() {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const addition = result.changes.find(c => c.symbolName === 'internal');
            expect(addition).toBeDefined();
        });

        it('should detect named export to default export', async () => {
            const oldCode = `
export function helper() {}
            `;
            
            const newCode = `
export default function helper() {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            expect(result.changes.length).toBeGreaterThan(0);
        });

        it('should detect multiple export changes', async () => {
            const oldCode = `
export function a() {}
export function b() {}
export function c() {}
            `;
            
            const newCode = `
export function a() {}
export function c() {}
export function d() {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const removal = result.changes.find(c => c.type === 'remove' && c.symbolName === 'b');
            const addition = result.changes.find(c => c.type === 'add' && c.symbolName === 'd');
            
            expect(removal).toBeDefined();
            expect(addition).toBeDefined();
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty files', async () => {
            const result = await engine.diff('test.ts', '', '');

            expect(result.changes).toHaveLength(0);
            expect(result.hasBreakingChanges).toBe(false);
        });

        it('should handle comments only changes', async () => {
            const oldCode = `
// Old implementation
export function test() {}
            `;
            
            const newCode = `
// New implementation
export function test() {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            expect(result.changes).toHaveLength(0);
        });

        it('should handle formatting changes', async () => {
            const oldCode = `export function test(){return true;}`;
            const newCode = `
export function test() {
    return true;
}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            expect(result.hasBreakingChanges).toBe(false);
        });

        it('should handle very long parameter lists', async () => {
            const oldCode = `
export function complex(a: string, b: number, c: boolean): void {}
            `;
            
            const newCode = `
export function complex(
    a: string,
    b: number,
    c: boolean,
    d: any,
    e: any
): void {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const change = result.changes.find(c => c.symbolName === 'complex');
            expect(change).toBeDefined();
            expect(change?.isBreaking).toBe(true);
        });
    });

    describe('Real-world Scenarios', () => {
        it('should detect deprecation pattern', async () => {
            const oldCode = `
export function oldMethod() {}
            `;
            
            const newCode = `
/** @deprecated Use newMethod instead */
export function oldMethod() {}
export function newMethod() {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const addition = result.changes.find(c => c.type === 'add' && c.symbolName === 'newMethod');
            expect(addition).toBeDefined();
        });

        it('should detect API version upgrade pattern', async () => {
            const oldCode = `
export function processV1(data: any): void {}
            `;
            
            const newCode = `
export function processV1(data: any): void {}
export function processV2(data: any, options: any): void {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            const addition = result.changes.find(c => c.symbolName === 'processV2');
            expect(addition).toBeDefined();
            expect(addition?.isBreaking).toBe(false);
        });

        it('should detect refactoring split', async () => {
            const oldCode = `
export function processAll(data: any): void {
    // Complex logic
}
            `;
            
            const newCode = `
export function validate(data: any): boolean {
    return true;
}
export function transform(data: any): any {
    return data;
}
export function processAll(data: any): void {
    if (validate(data)) {
        transform(data);
    }
}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            expect(result.changes.filter(c => c.type === 'add').length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('No Changes', () => {
        it('should return empty changes for identical code', async () => {
            const code = `
export function test() {}
export class MyClass {}
            `;

            const result = await engine.diff('test.ts', code, code);

            expect(result.changes).toHaveLength(0);
            expect(result.hasBreakingChanges).toBe(false);
            expect(result.affectedSymbols.size).toBe(0);
        });

        it('should ignore whitespace-only changes', async () => {
            const oldCode = `export function test() {}`;
            const newCode = `export  function  test()  {}`;

            const result = await engine.diff('test.ts', oldCode, newCode);

            expect(result.changes).toHaveLength(0);
            expect(result.hasBreakingChanges).toBe(false);
        });

        it('should ignore comment changes', async () => {
            const oldCode = `
// Old comment
export function test() {}
            `;
            const newCode = `
// New comment
export function test() {}
            `;

            const result = await engine.diff('test.ts', oldCode, newCode);

            expect(result.changes).toHaveLength(0);
            expect(result.hasBreakingChanges).toBe(false);
        });
    });
});
