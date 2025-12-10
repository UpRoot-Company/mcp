import * as fs from 'fs';
import * as path from 'path';
import { AstBackend, AstDocument } from './AstBackend.js';

interface SnapshotBackendOptions {
    snapshotDir: string;
    rootPath: string;
}

export class SnapshotBackend implements AstBackend {
    name = 'snapshot';
    capabilities = {
        supportsComments: false,
        supportsTypeAnnotations: false,
        supportsQueries: false,
        nodeTypeNormalization: 'native' as const
    };

    private snapshotDir: string;
    private rootPath: string;

    constructor(options: SnapshotBackendOptions) {
        this.snapshotDir = options.snapshotDir;
        this.rootPath = options.rootPath;
    }

    async initialize(): Promise<void> {
        if (!fs.existsSync(this.snapshotDir)) {
            throw new Error(`Snapshot directory ${this.snapshotDir} does not exist`);
        }
    }

    async parseFile(absPath: string, content: string): Promise<AstDocument> {
        const rel = path.relative(this.rootPath, absPath);
        const snapshotPath = path.join(this.snapshotDir, rel + '.json');

        if (!fs.existsSync(snapshotPath)) {
            throw new Error(`Snapshot not found for ${rel} at ${snapshotPath}`);
        }

        const raw = await fs.promises.readFile(snapshotPath, 'utf-8');
        const snapshot = JSON.parse(raw);

        const fallbackLanguage = path.extname(absPath).replace('.', '') || 'unknown';

        return {
            rootNode: snapshot.rootNode ?? null,
            languageId: snapshot.languageId ?? fallbackLanguage,
            dispose: () => { /* nothing */ }
        };
    }

    async getLanguage(languageId: string): Promise<any> {
        return { name: languageId, backend: this.name };
    }
}
