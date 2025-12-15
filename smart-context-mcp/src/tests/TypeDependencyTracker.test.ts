import * as fs from 'fs';
import * as path from 'path';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { TypeDependencyTracker } from '../ast/TypeDependencyTracker.js';
import { AstManager } from '../ast/AstManager.js';
import { TypeGraphResult } from '../types.js';

describe('TypeDependencyTracker', () => {
    const testDir = path.join(process.cwd(), 'src', 'tests', 'type_dependency_test_env');


    let symbolIndex: SymbolIndex;
    let tracker: TypeDependencyTracker;

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

        writeFile('types/base.ts', `export interface Entity {
    id: string;
}

export interface Auditable extends Entity {
    auditTrail(): void;
}

export class BaseModel {}

export class Customer extends BaseModel implements Entity {
    id: string;
    constructor(id: string) {
        this.id = id;
    }
}

export class PremiumCustomer extends Customer implements Auditable {
    auditTrail() {}
}

export type CustomerResult = PremiumCustomer | Customer;
`);

        writeFile('types/derivatives.ts', `import { Customer } from "./base";

export class SpecialCustomer extends Customer {}
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
        tracker = new TypeDependencyTracker(testDir, symbolIndex);
    });

    const analyzeOrFail = async (
        symbolName: string,
        relativeFilePath: string,
        direction: 'incoming' | 'outgoing' | 'both',
        maxDepth: number
    ): Promise<TypeGraphResult> => {
        const absPath = path.join(testDir, relativeFilePath);
        const result = await tracker.analyzeType(symbolName, absPath, direction, maxDepth);
        if (!result) {
            throw new Error(`Expected type graph for ${symbolName} in ${relativeFilePath}`);
        }
        return result;
    };

    it('captures extends and implements relationships as outgoing dependencies', async () => {
        const graph = await analyzeOrFail('PremiumCustomer', path.join('types', 'base.ts'), 'outgoing', 2);
        const dependencyNames = graph.root.dependencies
            .map(edge => graph.visitedNodes[edge.toSymbolId].symbolName)
            .sort();

        expect(dependencyNames).toEqual(['Auditable', 'Customer']);
        expect(graph.truncated).toBe(false);
    });

    it('includes incoming types that extend or alias the target', async () => {
        const graph = await analyzeOrFail('Customer', path.join('types', 'base.ts'), 'incoming', 2);
        const parentNames = graph.root.parents.map(edge => graph.visitedNodes[edge.fromSymbolId].symbolName).sort();

        expect(parentNames).toContain('PremiumCustomer');
        expect(parentNames).toContain('SpecialCustomer');
        expect(graph.truncated).toBe(false);
    });

    it('tracks alias constituents as downstream dependencies', async () => {
        const graph = await analyzeOrFail('CustomerResult', path.join('types', 'base.ts'), 'outgoing', 1);
        const dependencyNames = graph.root.dependencies.map(edge => graph.visitedNodes[edge.toSymbolId].symbolName).sort();

        expect(dependencyNames).toEqual(['Customer', 'PremiumCustomer']);
    });
});
