import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexDatabase } from '../indexing/IndexDatabase.js';
import { SymbolInfo } from '../types.js';

const makeTempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smart-context-db-'));

describe('IndexDatabase', () => {
        let rootDir: string;
    let db: IndexDatabase | undefined;

    beforeEach(() => {
        rootDir = makeTempRoot();
    });

    afterEach(() => {
        if (db) {
            db.dispose();
            db = undefined;
        }
        fs.rmSync(rootDir, { recursive: true, force: true });
    });


    const makeSymbol = (name: string): SymbolInfo => ({
        type: 'function',
        name,
        range: { startLine: 0, endLine: 0, startByte: 0, endByte: name.length },
        content: `function ${name}() {}`,
        modifiers: [],
        doc: ''
    });

    it('persists and streams symbols per file', () => {
                db = new IndexDatabase(rootDir);

        const symbols = [makeSymbol('alpha'), makeSymbol('beta')];
        db.replaceSymbols({
            relativePath: 'src/main.ts',
            lastModified: Date.now(),
            language: 'typescript',
            symbols
        });

        const stored = db.readSymbols('src/main.ts');
        expect(stored).toHaveLength(2);
        expect(stored?.map(s => s.name)).toEqual(['alpha', 'beta']);

        const map = db.streamAllSymbols();
        expect(map.get('src/main.ts')).toHaveLength(2);
    });

    it('stores dependencies and unresolved imports with cleanup support', () => {
                db = new IndexDatabase(rootDir);

        const now = Date.now();

        db.replaceDependencies({
            relativePath: 'src/main.ts',
            lastModified: now,
            outgoing: [
                { targetPath: 'src/utils.ts', type: 'import', metadata: { source: './utils' } }
            ],
            unresolved: [
                { specifier: './missing', error: 'NotFound' }
            ]
        });

        const outgoing = db.getDependencies('src/main.ts', 'outgoing');
        expect(outgoing.map(dep => dep.target)).toContain('src/utils.ts');

        const incoming = db.getDependencies('src/utils.ts', 'incoming');
        expect(incoming.map(dep => dep.source)).toContain('src/main.ts');

        const unresolved = db.listUnresolved();
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0]).toMatchObject({ specifier: './missing' });

        db.clearDependencies('src/main.ts');
        expect(db.getDependencies('src/main.ts', 'outgoing')).toHaveLength(0);
        expect(db.listUnresolved()).toHaveLength(0);
    });
});
