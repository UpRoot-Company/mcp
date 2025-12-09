import { DependencyGraph } from '../ast/DependencyGraph.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { ModuleResolver } from '../ast/ModuleResolver.js';
import { AstManager } from '../ast/AstManager.js';
import * as fs from 'fs';
import * as path from 'path';

describe('DependencyGraph', () => {
    const testDir = path.join(process.cwd(), 'src', 'tests', 'dep_graph_test_env');
    let graph: DependencyGraph;

    beforeAll(async () => {
        await AstManager.getInstance().init();
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
        fs.mkdirSync(testDir, { recursive: true });

        // Setup files for Direct Dependency Test
        fs.writeFileSync(path.join(testDir, 'utils.ts'), 'export const util = 1;');
        fs.writeFileSync(path.join(testDir, 'main.ts'), 'import { util } from "./utils";');
        
        // component imports shared
        fs.mkdirSync(path.join(testDir, 'shared'));
        fs.writeFileSync(path.join(testDir, 'shared', 'index.ts'), 'export const shared = 2;');
        fs.writeFileSync(path.join(testDir, 'component.ts'), 'import { shared } from "./shared";');

        // Setup files for Transitive & Cycle Test
        // chain: A -> B -> C
        fs.writeFileSync(path.join(testDir, 'C.ts'), 'export const c = 3;');
        fs.writeFileSync(path.join(testDir, 'B.ts'), 'import { c } from "./C"; export const b = 2;');
        fs.writeFileSync(path.join(testDir, 'A.ts'), 'import { b } from "./B"; export const a = 1;');

        // cycle: X -> Y -> X
        fs.writeFileSync(path.join(testDir, 'X.ts'), 'import { y } from "./Y"; export const x = 1;');
        fs.writeFileSync(path.join(testDir, 'Y.ts'), 'import { x } from "./X"; export const y = 2;');
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

        beforeEach(async () => {
        const generator = new SkeletonGenerator();
        const index = new SymbolIndex(testDir, generator, []);
        const resolver = new ModuleResolver(testDir);
        graph = new DependencyGraph(testDir, index, resolver);
        // Build graph explicitly
        await graph.build();
    });

    it('should resolve outgoing dependencies', async () => {
        const deps = await graph.getDependencies('main.ts', 'outgoing');
        const normalizedDeps = deps.map((d: string) => d.replace(/\\/g, '/'));
        expect(normalizedDeps).toContain('utils.ts');
    });

    it('should resolve incoming dependencies', async () => {
        const deps = await graph.getDependencies('utils.ts', 'incoming');
        const normalizedDeps = deps.map((d: string) => d.replace(/\\/g, '/'));
        expect(normalizedDeps).toContain('main.ts');
    });

    it('should handle directory index resolution', async () => {
        const deps = await graph.getDependencies('component.ts', 'outgoing');
        const normalizedDeps = deps.map((d: string) => d.replace(/\\/g, '/'));
        expect(normalizedDeps).toContain('shared/index.ts');
    });

    it('should resolve transitive outgoing dependencies', async () => {
        const deps = await graph.getTransitiveDependencies('A.ts', 'outgoing');
        const normalizedDeps = deps.map((d: string) => d.replace(/\\/g, '/'));
        expect(normalizedDeps).toContain('B.ts');
        expect(normalizedDeps).toContain('C.ts');
        expect(normalizedDeps.length).toBe(2);
    });

    it('should resolve transitive incoming dependencies (Impact Analysis)', async () => {
        const deps = await graph.getTransitiveDependencies('C.ts', 'incoming');
        const normalizedDeps = deps.map((d: string) => d.replace(/\\/g, '/'));
        expect(normalizedDeps).toContain('B.ts');
        expect(normalizedDeps).toContain('A.ts');
        expect(normalizedDeps.length).toBe(2);
    });

    it('should handle circular dependencies gracefully', async () => {
        const deps = await graph.getTransitiveDependencies('X.ts', 'outgoing');
        const normalizedDeps = deps.map((d: string) => d.replace(/\\/g, '/'));
        expect(normalizedDeps).toContain('Y.ts');
        // X -> Y -> X. Should contain Y. X is start node, visited set handles it.
        // It should NOT loop infinitely.
        expect(normalizedDeps.length).toBe(1); 
    });
});
