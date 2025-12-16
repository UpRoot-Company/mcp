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
    let symbolIndex: SymbolIndex;

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

        // unresolved import test file
        fs.writeFileSync(
            path.join(testDir, 'broken.ts'),
            'import { missing } from "./does-not-exist"; export const broken = missing;'
        );
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        const generator = new SkeletonGenerator();
        symbolIndex = new SymbolIndex(testDir, generator, []);
        const resolver = new ModuleResolver(testDir);
        graph = new DependencyGraph(testDir, symbolIndex, resolver);
        // Build graph explicitly
        await graph.build();
    });

    it('should resolve outgoing dependencies', async () => {
        const deps = await graph.getDependencies('main.ts', 'downstream');
        const normalizedDeps = deps.map(d => d.to.replace(/\\/g, '/'));
        expect(normalizedDeps).toContain('utils.ts');
    });

    it('should resolve incoming dependencies', async () => {
        const deps = await graph.getDependencies('utils.ts', 'upstream');
        const normalizedDeps = deps.map(d => d.from.replace(/\\/g, '/'));
        expect(normalizedDeps).toContain('main.ts');
    });

    it('should handle directory index resolution', async () => {
        const deps = await graph.getDependencies('component.ts', 'downstream');
        const normalizedDeps = deps.map(d => d.to.replace(/\\/g, '/'));
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

    describe('getIndexStatus', () => {
        it('should return correct file counts and unresolved imports', async () => {
            await graph.build();
            const status = await graph.getIndexStatus();
            
            // Total files: utils, main, shared/index, component, A, B, C, X, Y, broken = 10
            // The exact number depends on file system scan, but at least these should be present
            expect(status.global.totalFiles).toBeGreaterThanOrEqual(10); 
            expect(status.global.unresolvedImports).toBeGreaterThan(0);
            expect(status.global.indexedFiles).toBeGreaterThanOrEqual(status.global.totalFiles);
            
            // broken.ts imports ./does-not-exist
            // Normalize path separators for windows compatibility in check
            const error = status.global.resolutionErrors.find(e => 
                e.filePath.replace(/\\/g, '/').includes('broken.ts')
            );
            expect(error).toBeDefined();
            expect(error?.importSpecifier).toBe('./does-not-exist');
            expect(status.perFile?.['broken.ts']?.unresolvedImports).toContain('./does-not-exist');
        });

        it('should update timestamp on rebuild', async () => {
            await graph.build();
            const firstStatus = await graph.getIndexStatus();
            const firstTime = new Date(firstStatus.global.lastRebuiltAt).getTime();
            
            // Wait a bit to ensure time difference
            await new Promise(r => setTimeout(r, 100));
            
            await graph.build();
            const secondStatus = await graph.getIndexStatus();
            const secondTime = new Date(secondStatus.global.lastRebuiltAt).getTime();
            
            expect(secondTime).toBeGreaterThan(firstTime);
        });
    });

    describe('index invalidation', () => {
        it('drops dependencies after file invalidation and repopulates after update', async () => {
            await graph.invalidateFile(path.join(testDir, 'main.ts'));
            let deps = await graph.getDependencies('main.ts', 'downstream');
            expect(deps).toHaveLength(0);

            await graph.updateFileDependencies(path.join(testDir, 'main.ts'));
            deps = await graph.getDependencies('main.ts', 'downstream');
            const normalizedDeps = deps.map(d => d.to.replace(/\\/g, '/'));
            expect(normalizedDeps).toContain('utils.ts');
        });

        it('removes directory-scoped data until affected files are reprocessed', async () => {
            await graph.invalidateDirectory(path.join(testDir, 'shared'));
            let deps = await graph.getDependencies('component.ts', 'downstream');
            expect(deps).toHaveLength(0);

            await graph.updateFileDependencies(path.join(testDir, 'shared', 'index.ts'));
            await graph.updateFileDependencies(path.join(testDir, 'component.ts'));
            deps = await graph.getDependencies('component.ts', 'downstream');
            const normalizedDeps = deps.map(d => d.to.replace(/\\/g, '/'));
            expect(normalizedDeps).toContain('shared/index.ts');
        });

        it('removes persisted entries when files are deleted explicitly', async () => {
            await graph.removeFile(path.join(testDir, 'utils.ts'));
            const incoming = await graph.getDependencies('utils.ts', 'upstream');
            expect(incoming).toHaveLength(0);

            // Restore file for other tests
            fs.writeFileSync(path.join(testDir, 'utils.ts'), 'export const util = 1;');
            await graph.updateFileDependencies(path.join(testDir, 'utils.ts'));
            await graph.updateFileDependencies(path.join(testDir, 'main.ts'));
        });
    });
});
