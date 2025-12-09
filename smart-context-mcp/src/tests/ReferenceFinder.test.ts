import { ReferenceFinder } from '../ast/ReferenceFinder.js';
import { DependencyGraph } from '../ast/DependencyGraph.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { ModuleResolver } from '../ast/ModuleResolver.js';
import { AstManager } from '../ast/AstManager.js';
import * as fs from 'fs';
import * as path from 'path';

describe('ReferenceFinder', () => {
    const testDir = path.join(process.cwd(), 'src', 'tests', 'ref_finder_test_env');
    let finder: ReferenceFinder;
    let graph: DependencyGraph;

    beforeAll(async () => {
        await AstManager.getInstance().init();
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
        fs.mkdirSync(testDir, { recursive: true });

        // def.ts
        fs.writeFileSync(path.join(testDir, 'def.ts'), `
            export const target = 1;
            export function internal() {
                return target;
            }
        `);

        // user.ts (Direct import)
        fs.writeFileSync(path.join(testDir, 'user.ts'), `
            import { target } from './def';
            const a = target;
        `);

        // alias.ts (Aliased import)
        fs.writeFileSync(path.join(testDir, 'alias.ts'), `
            import { target as t } from './def';
            const b = t;
        `);
        
        fs.writeFileSync(path.join(testDir, 'unused.ts'), `
            import { target } from './def';
        `);
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

        beforeEach(async () => {
        const generator = new SkeletonGenerator();
        const index = new SymbolIndex(testDir, generator, []);
        const resolver = new ModuleResolver(testDir);
        graph = new DependencyGraph(testDir, index, resolver);
        
        await graph.build();
        
        finder = new ReferenceFinder(testDir, graph, index, generator, resolver);
    });

    it('should find references in definition file (local usage)', async () => {
        const defPath = path.join(testDir, 'def.ts');
        const refs = await finder.findReferences('target', defPath);
        
        const localRef = refs.find((r: any) => r.filePath === 'def.ts' && r.text === 'target');
        expect(localRef).toBeDefined();
    });

    it('should find references in importing files', async () => {
        const defPath = path.join(testDir, 'def.ts');
        const refs = await finder.findReferences('target', defPath);
        
        const userRef = refs.find((r: any) => r.filePath === 'user.ts');
        expect(userRef).toBeDefined();
        expect(userRef!.text).toBe('target');
    });

    it('should find aliased references', async () => {
        const defPath = path.join(testDir, 'def.ts');
        const refs = await finder.findReferences('target', defPath);
        
        const aliasRef = refs.find((r: any) => r.filePath === 'alias.ts');
        expect(aliasRef).toBeDefined();
        expect(aliasRef!.text).toBe('t');
    });

    it('should find references for namespace import with default export', async () => {
        fs.writeFileSync(path.join(testDir, 'def_default.ts'), `
            export default class A {}
        `);
        
        fs.writeFileSync(path.join(testDir, 'ns_user.ts'), `
            import * as ns from './def_default';
            const a = new ns.default();
        `);
        
        // Force rebuild graph to pick up new files
        await graph.build();
        
        const defPath = path.join(testDir, 'def_default.ts');
        const refs = await finder.findReferences('A', defPath);
        
        const ref = refs.find((r: any) => r.filePath === 'ns_user.ts');
        expect(ref).toBeDefined();
        expect(ref!.text).toBe('default'); 
    });
});
