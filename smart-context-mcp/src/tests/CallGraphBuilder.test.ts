import * as fs from 'fs';
import * as path from 'path';
import { CallGraphBuilder } from '../ast/CallGraphBuilder.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { ModuleResolver } from '../ast/ModuleResolver.js';
import { AstManager } from '../ast/AstManager.js';
import { CallGraphResult } from '../types.js';

describe('CallGraphBuilder', () => {
    const testDir = path.join(process.cwd(), 'src', 'tests', 'call_graph_test_env');
    const rel = (filePath: string) => path.relative(testDir, filePath).replace(/\\/g, '/');

    let symbolIndex: SymbolIndex;
    let callGraphBuilder: CallGraphBuilder;

    const writeFile = (relativePath: string, content: string) => {
        const absPath = path.join(testDir, relativePath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content);
    };

    beforeAll(async () => {
        await AstManager.getInstance().init();
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        fs.mkdirSync(testDir, { recursive: true });

        writeFile('utils/adder.ts', `export function add(a: number, b: number) {
    return a + b;
}
`);

        writeFile('utils/multiplier.ts', `export function multiply(value: number, factor: number) {
    return value * factor;
}
`);

        writeFile('services/cart.ts', `import { add } from "../utils/adder";
import { multiply } from "../utils/multiplier";

export function computeTotal(price: number, quantity: number) {
    return add(price, multiply(quantity, 2));
}
`);

        writeFile('app/checkout.ts', `import { computeTotal } from "../services/cart";

export function runCheckout(price: number, quantity: number) {
    return computeTotal(price, quantity);
}
`);

        writeFile('app/dashboard.ts', `import { computeTotal } from "../services/cart";

export function summarize(price: number, quantity: number) {
    return computeTotal(price, quantity);
}
`);
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        const generator = new SkeletonGenerator();
        symbolIndex = new SymbolIndex(testDir, generator, []);
        const moduleResolver = new ModuleResolver(testDir);
        callGraphBuilder = new CallGraphBuilder(testDir, symbolIndex, moduleResolver);
    });

    const analyzeOrFail = async (
        symbolName: string,
        relativeFilePath: string,
        direction: 'upstream' | 'downstream' | 'both',
        maxDepth: number
    ): Promise<CallGraphResult> => {
        const absPath = path.join(testDir, relativeFilePath);
        const result = await callGraphBuilder.analyzeSymbol(symbolName, absPath, direction, maxDepth);
        if (!result) {
            throw new Error(`Expected call graph for ${symbolName} in ${relativeFilePath}`);
        }
        return result;
    };

    it('resolves downstream callees through named imports', async () => {
        const graph = await analyzeOrFail('computeTotal', path.join('services', 'cart.ts'), 'downstream', 2);
        const calleeNames = graph.root.callees
            .map(edge => graph.visitedNodes[edge.toSymbolId].symbolName)
            .sort();

        expect(graph.truncated).toBe(false);
        expect(calleeNames).toEqual(['add', 'multiply']);

        const expectedAddId = `${rel(path.join(testDir, 'utils', 'adder.ts'))}::add`;
        expect(graph.visitedNodes[expectedAddId]).toBeDefined();
    });

    it('expands upstream callers and includes transitive parents', async () => {
        const graph = await analyzeOrFail('add', path.join('utils', 'adder.ts'), 'upstream', 2);
        const callerNames = graph.root.callers.map(edge => graph.visitedNodes[edge.fromSymbolId].symbolName);

        expect(callerNames).toContain('computeTotal');

        const checkoutId = `${rel(path.join(testDir, 'app', 'checkout.ts'))}::runCheckout`;
        const dashboardId = `${rel(path.join(testDir, 'app', 'dashboard.ts'))}::summarize`;
        expect(graph.visitedNodes[checkoutId]).toBeDefined();
        expect(graph.visitedNodes[dashboardId]).toBeDefined();
        expect(graph.truncated).toBe(false);
    });

    it('honors maxDepth limits for upstream searches', async () => {
        const graph = await analyzeOrFail('add', path.join('utils', 'adder.ts'), 'upstream', 1);
        const checkoutId = `${rel(path.join(testDir, 'app', 'checkout.ts'))}::runCheckout`;

        expect(graph.visitedNodes[checkoutId]).toBeUndefined();
        expect(graph.truncated).toBe(true);
    });
});
