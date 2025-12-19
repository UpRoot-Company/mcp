import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GhostInterfaceBuilder } from '../resolution/GhostInterfaceBuilder.js';
import { SearchEngine } from '../engine/Search.js';
import { CallSiteAnalyzer } from '../ast/analysis/CallSiteAnalyzer.js';
import { AstManager } from '../ast/AstManager.js';
import { NodeFileSystem } from '../platform/FileSystem.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { IndexDatabase } from '../indexing/IndexDatabase.js';

describe('GhostInterfaceBuilder', () => {
    let builder: GhostInterfaceBuilder;
    let tempDir: string;
    let astManager: AstManager;
    let searchEngine: SearchEngine;
    let symbolIndex: SymbolIndex;
    let db: IndexDatabase;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-interface-test-'));
        const fileSystem = new NodeFileSystem(tempDir);
        
        AstManager.resetForTesting();
        astManager = AstManager.getInstance();
        await astManager.init({ mode: 'test', rootPath: tempDir });

        const skeletonGen = new SkeletonGenerator();
        db = new IndexDatabase(tempDir);
        symbolIndex = new SymbolIndex(tempDir, skeletonGen, [], db);
        
        searchEngine = new SearchEngine(tempDir, fileSystem, [], {
            symbolIndex
        });
        await searchEngine.warmup();

        builder = new GhostInterfaceBuilder(
            searchEngine,
            new CallSiteAnalyzer(),
            astManager,
            fileSystem,
            tempDir
        );
    });

    afterEach(async () => {
        await symbolIndex.dispose();
        await searchEngine.dispose();
        db.dispose();
        AstManager.resetForTesting();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should reconstruct a ghost interface from usage patterns', async () => {
        const usageFile = path.join(tempDir, 'usage.ts');
        fs.writeFileSync(usageFile, `
            import { MissingService } from './missing';
            
            async function test() {
                const svc = new MissingService();
                await svc.saveData({ id: 1 });
                const data = svc.fetchData(123);
                svc.unknownMethod();
            }
        `);

        // We need to trigger indexing or at least make searchEngine aware of it
        await searchEngine.rebuild();

        const ghost = await builder.reconstruct('MissingService');

        expect(ghost).toBeDefined();
        expect(ghost?.name).toBe('MissingService');
        expect(ghost?.methods.length).toBeGreaterThan(0);
        
        const methodNames = ghost?.methods.map(m => m.name);
        expect(methodNames).toContain('saveData');
        expect(methodNames).toContain('fetchData');
        expect(methodNames).toContain('unknownMethod');
        expect(methodNames).toContain('constructor');
    });

    it('should return null if no usage is found', async () => {
        const ghost = await builder.reconstruct('NonExistentSymbol');
        expect(ghost).toBeNull();
    });
});
