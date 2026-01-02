import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolInfo } from '../types.js';
import { MigrationRunner } from "./MigrationRunner.js";
import { PathManager } from "../utils/PathManager.js";

export interface FileRecord {
    id: number;
    path: string;
    last_modified: number;
    language?: string | null;
}

export interface DependencyRecord {
    source: string;
    target: string;
    type: string;
    weight: number;
    metadata?: Record<string, unknown>;
}

interface SymbolRow {
    data_json: string;
}

interface StatementMap {
    insertFile: Database.Statement;
    updateFile: Database.Statement;
    getFileByPath: Database.Statement;
    deleteFileByPath: Database.Statement;
    deleteFilesByPrefix: Database.Statement;
    selectFiles: Database.Statement;
    deleteSymbolsForFile: Database.Statement;
    insertSymbol: Database.Statement;
    getSymbolsForFile: Database.Statement;
    selectAllSymbols: Database.Statement;
    deleteDependenciesForSource: Database.Statement;
    insertDependency: Database.Statement;
    selectDependenciesBySource: Database.Statement;
    selectDependenciesByTarget: Database.Statement;
    countDependenciesBySource: Database.Statement;
    countDependenciesByTarget: Database.Statement;
    deleteUnresolvedForSource: Database.Statement;
    insertUnresolved: Database.Statement;
    selectUnresolved: Database.Statement;
    selectUnresolvedByFile: Database.Statement;
    searchSymbols: Database.Statement;
    // Tier 3: Ghost Registry
    insertGhost: Database.Statement;
    getGhost: Database.Statement;
    deleteGhost: Database.Statement;
    listGhosts: Database.Statement;
    pruneGhosts: Database.Statement;
}

export class IndexDatabase {
    private readonly db: Database.Database;
    private readonly statements: StatementMap;

    constructor(private readonly rootPath: string) {
        // Ensure all PathManager-resolved storage paths are scoped to the intended project root.
        // This matters for tests (isolated temp roots) and for any embedding scenario where the
        // process cwd is not the project root.
        PathManager.setRoot(this.rootPath);

        let dbPath: string = ':memory:';
        try {
            dbPath = this.ensureDataDir();
            this.db = new Database(dbPath);
        } catch (error) {
            console.error(`[IndexDatabase] Failed to open database:`, error);
            console.error('[IndexDatabase] Falling back to in-memory database. Persistence will be disabled.');
            if (this.isNativeModuleFailure(error)) {
                console.error('[IndexDatabase] better-sqlite3 native module failed to load. Ensure Node.js version matches and rebuild the module (ex: npm rebuild better-sqlite3).');
                throw error;
            }
            try {
                this.db = new Database(':memory:');
            } catch (fallbackError) {
                console.error('[IndexDatabase] Failed to open in-memory database:', fallbackError);
                throw fallbackError;
            }
        }

        try {
            this.configure();
            new MigrationRunner(this.db).run();
            this.statements = this.prepareStatements();
        } catch (error) {
            console.error('[IndexDatabase] Failed to initialize database schema:', error);
            if (dbPath !== ':memory:') {
                console.error('[IndexDatabase] Retrying with in-memory database due to configuration failure.');
                try {
                    this.db.close();
                } catch {}
                if (this.isNativeModuleFailure(error)) {
                    console.error('[IndexDatabase] better-sqlite3 native module failed to load. Ensure Node.js version matches and rebuild the module (ex: npm rebuild better-sqlite3).');
                    throw error;
                }
                this.db = new Database(':memory:');
                this.configure();
                new MigrationRunner(this.db).run();
                this.statements = this.prepareStatements();
            } else {
                throw error;
            }
        }
    }

    private isNativeModuleFailure(error: unknown): boolean {
        if (!error) return false;
        const message = String((error as { message?: unknown })?.message ?? error);
        const code = (error as { code?: unknown })?.code;
        return code === 'ERR_DLOPEN_FAILED' || message.includes('NODE_MODULE_VERSION');
    }

    public getHandle(): Database.Database {
        return this.db;
    }

    private ensureDataDir(): string {
        const dataDir = PathManager.getIndexDir();
        fs.mkdirSync(dataDir, { recursive: true });
        return path.join(dataDir, 'index.db');
    }

    private configure(): void {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -8000');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                last_modified INTEGER NOT NULL,
                language TEXT
            );

            CREATE TABLE IF NOT EXISTS symbols (
                id INTEGER PRIMARY KEY,
                file_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                signature TEXT,
                range_json TEXT NOT NULL,
                data_json TEXT NOT NULL,
                FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS dependencies (
                source_file_id INTEGER NOT NULL,
                target_file_id INTEGER,
                type TEXT NOT NULL,
                weight INTEGER DEFAULT 1,
                metadata_json TEXT,
                PRIMARY KEY(source_file_id, target_file_id, type),
                FOREIGN KEY(source_file_id) REFERENCES files(id) ON DELETE CASCADE,
                FOREIGN KEY(target_file_id) REFERENCES files(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS unresolved_dependencies (
                source_file_id INTEGER NOT NULL,
                specifier TEXT NOT NULL,
                error TEXT,
                metadata_json TEXT,
                PRIMARY KEY(source_file_id, specifier),
                FOREIGN KEY(source_file_id) REFERENCES files(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS ghost_symbols (
                name TEXT PRIMARY KEY,
                last_seen_path TEXT NOT NULL,
                kind TEXT NOT NULL,
                signature TEXT,
                deleted_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
            CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
            CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_file_id);
            CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_file_id);
        `);
    }

    private prepareStatements(): StatementMap {
        return {
            insertFile: this.db.prepare(`
                INSERT INTO files(path, last_modified, language) VALUES(?, ?, ?)
            `),
            updateFile: this.db.prepare(`
                UPDATE files SET last_modified = ?, language = ? WHERE id = ?
            `),
            getFileByPath: this.db.prepare(`
                SELECT id, path, last_modified, language FROM files WHERE path = ?
            `),
            deleteFileByPath: this.db.prepare(`
                DELETE FROM files WHERE path = ?
            `),
            deleteFilesByPrefix: this.db.prepare(`
                DELETE FROM files WHERE path = ? OR path LIKE ?
            `),
            selectFiles: this.db.prepare(`
                SELECT id, path, last_modified, language FROM files
            `),
            deleteSymbolsForFile: this.db.prepare(`
                DELETE FROM symbols WHERE file_id = ?
            `),
            insertSymbol: this.db.prepare(`
                INSERT INTO symbols(file_id, name, kind, signature, range_json, data_json)
                VALUES(?, ?, ?, ?, ?, ?)
            `),
            getSymbolsForFile: this.db.prepare(`
                SELECT data_json FROM symbols WHERE file_id = ?
            `),
            selectAllSymbols: this.db.prepare(`
                SELECT files.path as path, symbols.data_json as data_json
                FROM symbols
                JOIN files ON files.id = symbols.file_id
                ORDER BY files.path
            `),
            deleteDependenciesForSource: this.db.prepare(`
                DELETE FROM dependencies WHERE source_file_id = ?
            `),
            insertDependency: this.db.prepare(`
                INSERT OR REPLACE INTO dependencies(source_file_id, target_file_id, type, weight, metadata_json)
                VALUES(?, ?, ?, ?, ?)
            `),
            selectDependenciesBySource: this.db.prepare(`
                SELECT f.path as path, d.type, d.weight, d.metadata_json
                FROM dependencies d
                JOIN files f ON f.id = d.target_file_id
                WHERE d.source_file_id = ?
            `),
            selectDependenciesByTarget: this.db.prepare(`
                SELECT f.path as path, d.type, d.weight, d.metadata_json
                FROM dependencies d
                JOIN files f ON f.id = d.source_file_id
                WHERE d.target_file_id = ?
            `),
            countDependenciesBySource: this.db.prepare(`
                SELECT COUNT(*) as count FROM dependencies d
                JOIN files f ON f.id = d.source_file_id
                WHERE f.path = ?
            `),
            countDependenciesByTarget: this.db.prepare(`
                SELECT COUNT(*) as count FROM dependencies d
                JOIN files f ON f.id = d.target_file_id
                WHERE f.path = ?
            `),
            deleteUnresolvedForSource: this.db.prepare(`
                DELETE FROM unresolved_dependencies WHERE source_file_id = ?
            `),
            insertUnresolved: this.db.prepare(`
                INSERT OR REPLACE INTO unresolved_dependencies(source_file_id, specifier, error, metadata_json)
                VALUES(?, ?, ?, ?)
            `),
            selectUnresolved: this.db.prepare(`
                SELECT f.path as path, u.specifier as specifier, u.error as error, u.metadata_json as metadata
                FROM unresolved_dependencies u
                JOIN files f ON f.id = u.source_file_id
            `),
            selectUnresolvedByFile: this.db.prepare(`
                SELECT u.specifier as specifier, u.error as error, u.metadata_json as metadata
                FROM unresolved_dependencies u
                JOIN files f ON f.id = u.source_file_id
                WHERE f.path = ?
            `),
            searchSymbols: this.db.prepare(`
                SELECT f.path as path, s.data_json as data_json
                FROM symbols s
                JOIN files f ON f.id = s.file_id
                WHERE s.name LIKE ?
                LIMIT ?
            `),
            insertGhost: this.db.prepare(`
                INSERT OR REPLACE INTO ghost_symbols(name, last_seen_path, kind, signature, deleted_at)
                VALUES(?, ?, ?, ?, ?)
            `),
            getGhost: this.db.prepare(`
                SELECT name, last_seen_path as lastSeenPath, kind as type, signature as lastKnownSignature, deleted_at as deletedAt
                FROM ghost_symbols WHERE name = ?
            `),
            deleteGhost: this.db.prepare(`
                DELETE FROM ghost_symbols WHERE name = ?
            `),
            listGhosts: this.db.prepare(`
                SELECT name, last_seen_path as lastSeenPath, kind as type, signature as lastKnownSignature, deleted_at as deletedAt
                FROM ghost_symbols ORDER BY deleted_at DESC
            `),
            pruneGhosts: this.db.prepare(`
                DELETE FROM ghost_symbols WHERE deleted_at < ?
            `)
        };
    }

    public searchSymbols(pattern: string, limit: number = 100): Array<{ path: string; data_json: string }> {
        return this.statements.searchSymbols.all(pattern, limit) as any;
    }

    public getOrCreateFile(relativePath: string, lastModified?: number, language?: string | null): FileRecord {
        const normalized = this.normalize(relativePath);
        const existing = this.statements.getFileByPath.get(normalized) as FileRecord | undefined;
        if (existing) {
            if (lastModified !== undefined) {
                this.statements.updateFile.run(lastModified, language ?? null, existing.id);
                return { ...existing, last_modified: lastModified, language: language ?? null };
            }
            return existing;
        }
        const info = this.statements.insertFile.run(normalized, lastModified ?? 0, language ?? null);
        const id = Number(info.lastInsertRowid);
        return { id, path: normalized, last_modified: lastModified ?? 0, language: language ?? null };
    }

    public getFile(relativePath: string): FileRecord | undefined {
        const normalized = this.normalize(relativePath);
        return this.statements.getFileByPath.get(normalized) as FileRecord | undefined;
    }

    public replaceSymbols(args: { relativePath: string; lastModified: number; language?: string | null; symbols: SymbolInfo[]; }): void {
        const file = this.getOrCreateFile(args.relativePath, args.lastModified, args.language);
        const tx = this.db.transaction((fileId: number, symbols: SymbolInfo[]) => {
            this.statements.deleteSymbolsForFile.run(fileId);
            for (const symbol of symbols) {
                const serialized = JSON.stringify(symbol);
                const rangeJson = JSON.stringify(symbol.range ?? null);
                this.statements.insertSymbol.run(
                    fileId,
                    symbol.name,
                    symbol.type,
                    'signature' in symbol ? (symbol as any).signature ?? null : null,
                    rangeJson,
                    serialized
                );
            }
        });
        tx(file.id, args.symbols);
    }

    public readSymbols(relativePath: string): SymbolInfo[] | undefined {
        const file = this.getFile(relativePath);
        if (!file) return undefined;
        const rows = this.statements.getSymbolsForFile.all(file.id) as SymbolRow[];
        return rows.map(row => JSON.parse(row.data_json) as SymbolInfo);
    }

    public streamAllSymbols(): Map<string, SymbolInfo[]> {
        const rows = this.statements.selectAllSymbols.all() as { path: string; data_json: string; }[];
        const result = new Map<string, SymbolInfo[]>();
        for (const row of rows) {
            if (!result.has(row.path)) {
                result.set(row.path, []);
            }
            result.get(row.path)!.push(JSON.parse(row.data_json) as SymbolInfo);
        }
        return result;
    }

    public replaceDependencies(args: {
        relativePath: string;
        lastModified: number;
        outgoing: Array<{ targetPath?: string; type: string; weight?: number; metadata?: Record<string, unknown> }>;
        unresolved: Array<{ specifier: string; error?: string; metadata?: Record<string, unknown> }>;
    }): void {
        const file = this.getOrCreateFile(args.relativePath, args.lastModified);
        const tx = this.db.transaction((fileId: number) => {
            this.statements.deleteDependenciesForSource.run(fileId);
            this.statements.deleteUnresolvedForSource.run(fileId);
            for (const dep of args.outgoing) {
                if (!dep.targetPath) continue;
                const target = this.getOrCreateFile(dep.targetPath);
                this.statements.insertDependency.run(
                    fileId,
                    target.id,
                    dep.type,
                    dep.weight ?? 1,
                    dep.metadata ? JSON.stringify(dep.metadata) : null
                );
            }
            for (const unresolved of args.unresolved) {
                this.statements.insertUnresolved.run(
                    fileId,
                    unresolved.specifier,
                    unresolved.error ?? null,
                    unresolved.metadata ? JSON.stringify(unresolved.metadata) : null
                );
            }
        });
        tx(file.id);
    }

    public getDependencies(relativePath: string, direction: 'incoming' | 'outgoing'): DependencyRecord[] {
        const file = this.getFile(relativePath);
        if (!file) return [];
        const rows = (direction === 'outgoing'
            ? this.statements.selectDependenciesBySource.all(file.id)
            : this.statements.selectDependenciesByTarget.all(file.id)) as Array<{ path: string; type: string; weight: number; metadata_json: string | null }>;
        return rows.map(row => ({
            source: direction === 'outgoing' ? relativePath : row.path,
            target: direction === 'outgoing' ? row.path : relativePath,
            type: row.type,
            weight: row.weight,
            metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined
        }));
    }

    public countDependencies(relativePath: string, direction: 'incoming' | 'outgoing'): number {
        const statement = direction === 'outgoing'
            ? this.statements.countDependenciesBySource
            : this.statements.countDependenciesByTarget;
        const row = statement.get(this.normalize(relativePath)) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    public listUnresolved(): { filePath: string; specifier: string; error?: string; metadata?: Record<string, unknown> }[] {
        const rows = this.statements.selectUnresolved.all() as Array<{ path: string; specifier: string; error?: string; metadata?: string }>;
        return rows.map(row => ({
            filePath: row.path,
            specifier: row.specifier,
            error: row.error,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        }));
    }

    public listUnresolvedForFile(relativePath: string): { specifier: string; error?: string; metadata?: Record<string, unknown> }[] {
        const normalized = this.normalize(relativePath);
        const rows = this.statements.selectUnresolvedByFile.all(normalized) as Array<{ specifier: string; error?: string; metadata?: string }>;
        return rows.map(row => ({
            specifier: row.specifier,
            error: row.error,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        }));
    }

    public deleteFile(relativePath: string): void {
        const normalized = this.normalize(relativePath);
        this.statements.deleteFileByPath.run(normalized);
    }

    public deleteFilesByPrefix(relativePath: string): void {
        const normalized = this.normalize(relativePath);
        this.statements.deleteFilesByPrefix.run(normalized, `${normalized}/%`);
    }

    public listFiles(): FileRecord[] {
        return this.statements.selectFiles.all() as FileRecord[];
    }

    public clearDependencies(relativePath: string): void {
        const file = this.getFile(relativePath);
        if (file) {
            this.statements.deleteDependenciesForSource.run(file.id);
            this.statements.deleteUnresolvedForSource.run(file.id);
        }
    }

    public clearAllFiles(): void {
        const db = this.getHandle();
        try {
            db.exec('DELETE FROM symbols');
            db.exec('DELETE FROM dependencies');
            db.exec('DELETE FROM unresolved_dependencies');
            db.exec('DELETE FROM ghost_symbols');
            db.exec('DELETE FROM files');
            console.info('[IndexDatabase] All indexed files cleared');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to clear index database: ${message}`);
        }
    }

    // Ghost Management
    public addGhost(ghost: any): void {
        const lastSeen = this.normalize(ghost.lastSeenPath);
        this.statements.insertGhost.run(
            ghost.name,
            lastSeen,
            ghost.type,
            ghost.lastKnownSignature ?? null,
            ghost.deletedAt
        );
    }

    public findGhost(name: string): any | undefined {
        return this.statements.getGhost.get(name) as any | undefined;
    }

    public listGhosts(): any[] {
        return this.statements.listGhosts.all() as any[];
    }

    public deleteGhost(name: string): void {
        this.statements.deleteGhost.run(name);
    }

    public pruneGhosts(olderThanMs: number): void {
        const cutoff = Date.now() - olderThanMs;
        this.statements.pruneGhosts.run(cutoff);
    }

        public dispose(): void {
        try {
            this.db.close();
        } catch (error) {
            console.error('[IndexDatabase] Failed to close database:', error);
        }
    }

    public close(): void {
        this.dispose();
    }


    private normalize(relPath: string): string {
        let normalized = relPath.replace(/\\/g, '/');
        const resolvedRoot = path.resolve(this.rootPath).replace(/\\/g, '/');
        const realRoot = fs.existsSync(this.rootPath) ? fs.realpathSync(this.rootPath).replace(/\\/g, '/') : resolvedRoot;

        let absoluteInput = path.isAbsolute(normalized) ? normalized : path.resolve(this.rootPath, normalized).replace(/\\/g, '/');
        
        if (absoluteInput.startsWith(realRoot)) {
            normalized = absoluteInput.substring(realRoot.length);
        } else if (absoluteInput.startsWith(resolvedRoot)) {
            normalized = absoluteInput.substring(resolvedRoot.length);
        }

        if (normalized.startsWith('/')) {
            normalized = normalized.substring(1);
        }
        
        return normalized || '.';
    }
}
