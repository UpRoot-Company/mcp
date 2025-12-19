import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GhostArcheology } from '../ast/analysis/GhostArcheology.js';
import { IndexDatabase } from '../indexing/IndexDatabase.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { AstManager } from '../ast/AstManager.js';
import { JsAstBackend } from '../ast/JsAstBackend.js';

describe('Ghost Interface Archeology (Tier 3)', () => {
    let db: IndexDatabase;
    let ghost: GhostArcheology;
    let tempDir: string;
    let symbolIndex: SymbolIndex;

    beforeEach(async () => {
        AstManager.resetForTesting();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-test-'));
        db = new IndexDatabase(tempDir);
        ghost = new GhostArcheology(db);
        
        const astManager = AstManager.getInstance();
        await astManager.init({ mode: 'test' });
        const skeletonGen = new SkeletonGenerator();
        symbolIndex = new SymbolIndex(tempDir, skeletonGen, [], db);
    });

    afterEach(async () => {
        await symbolIndex.dispose();
        db.dispose();
        AstManager.resetForTesting();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should register a ghost symbol when a file is deleted', async () => {
        const filePath = path.join(tempDir, 'test.ts');
        const relPath = 'test.ts';
        fs.writeFileSync(filePath, 'export class GhostClass {}');

        // 1. Initial Indexing
        const symbols = await symbolIndex.getSymbolsForFile(filePath);
        expect(db.readSymbols(relPath)).toBeDefined();

        // 2. Delete File & Register Ghost
        await ghost.registerGhostsFromFile(relPath, symbols);
        
        // 3. Verify Ghost
        const found = ghost.findGhost('GhostClass');
        expect(found).toBeDefined();
        expect(found?.name).toBe('GhostClass');
        expect(found?.originalPath).toBe(relPath);
    });

    it('should register a ghost symbol when a symbol vanishes during update', async () => {
        const filePath = path.join(tempDir, 'vanishing.ts');
        const relPath = 'vanishing.ts';
        fs.writeFileSync(filePath, 'export class Dies {}\nexport class Survives {}');

        // 1. Initial Indexing
        const initialSymbols = await symbolIndex.getSymbolsForFile(filePath);
        expect(initialSymbols.map(s => s.name)).toContain('Dies');

        // 2. Update State - 'Dies' is gone
        const newContent = 'export class Survives {}';
        fs.writeFileSync(filePath, newContent);
        const newSymbols = await symbolIndex.getSymbolsForFile(filePath);
        
        // Find vanished symbols
        const vanished = initialSymbols.filter(s1 => !newSymbols.some(s2 => s2.name === s1.name));
        expect(vanished.map(s => s.name)).toContain('Dies');

        // 3. Register as ghosts
        await ghost.registerGhostsFromFile(relPath, vanished);

        // 4. Verify Ghost
        const found = ghost.findGhost('Dies');
        expect(found).toBeDefined();
        expect(ghost.findGhost('Survives')).toBeNull();
    });

    it('should list all current ghosts', async () => {
        // Clear potential ghosts from previous tests in this file
        // (IndexDatabase is per-test but SymbolIndex + AstManager might cause multiple registrations)
        db.pruneGhosts(-1000000); // Prune everything

        await ghost.registerGhostsFromFile('a.ts', [{ name: 'A', type: 'class' } as any]);
        await ghost.registerGhostsFromFile('b.ts', [{ name: 'B', type: 'function' } as any]);

        const list = ghost.listGhosts();
        expect(list.length).toBe(2);
        expect(list.map(g => g.name)).toContain('A');
        expect(list.map(g => g.name)).toContain('B');
    });
});
