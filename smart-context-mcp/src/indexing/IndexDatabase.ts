import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolInfo } from '../types.js';
import { MigrationRunner } from "./MigrationRunner.js";

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
}

export class IndexDatabase {
    private readonly db: Database.Database;
    private readonly statements: StatementMap;

    constructor(private readonly rootPath: string) {
        let dbPath: string = ':memory:';
        try {
            dbPath = this.ensureDataDir();
            this.db = new Database(dbPath);
        } catch (error) {
            console.error(`[IndexDatabase] Failed to open database at ${path.join(this.rootPath, '.smart-context')}:`, error);
            console.error('[IndexDatabase] Falling back to in-memory database. Persistence will be disabled.');
            this.db = new Database(':memory:');
        }
        
        try {
            this.configure();
            new MigrationRunner(this.db).run();
            this.statements = this.prepareStatements();
        } catch (error) {
            console.error('[IndexDatabase] Failed to initialize database schema:', error);
            // If schema init fails even in memory or after fallback, we might need a desperate fallback or re-throw
            // But let's try to survive with in-memory if the first attempt was file-based and failed later? 
            // Actually, if 'new Database' succeeded, configure/migration should mostly work unless sqlite binary is broken.
            // If it was file-based and failed during configure (e.g. WAL lock), we should catch that too.
            
            if (this.db.name !== ':memory:') {
                 console.error('[IndexDatabase] Retrying with in-memory database due to configuration failure.');
                 try {
                     this.db.close();
                 } catch {}
                 this.db = new Database(':memory:');
                 this.configure();
                 new MigrationRunner(this.db).run();
                 this.statements = this.prepareStatements();
            } else {
                throw error; // Memory db failed? Something is very wrong.
            }
        }
    }

    public getHandle(): Database.Database {
        return this.db;
    }

    private ensureDataDir(): string {
        const dataDir = path.join(this.rootPath, '.smart-context');
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
                SELECT f.path as path FROM dependencies d
                JOIN files f ON f.id = d.target_file_id
                WHERE d.source_file_id = ?
            `),
            selectDependenciesByTarget: this.db.prepare(`
                SELECT f.path as path FROM dependencies d
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
            `)
        };
    }

    public getOrCreateFile(relativePath: string, lastModified?: number, language?: string | null): FileRecord {
        const normalized = this.normalize(relativePath);
        const existing = this.statements.getFileByPath.get(normalized) as FileRecord | undefined;
        if (!existing) {
            const info = this.statements.insertFile.run(normalized, lastModified ?? 0, language ?? null);
            const id = Number(info.lastInsertRowid);
            return { id, path: normalized, last_modified: lastModified ?? 0, language: language ?? null };
        }
        if (typeof lastModified === 'number' && (existing.last_modified !== lastModified || (language && existing.language !== language))) {
            this.statements.updateFile.run(lastModified, language ?? null, existing.id);
            return { ...existing, last_modified: lastModified, language: language ?? null };
        }
        return existing;
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
                    'signature' in symbol ? symbol.signature ?? null : null,
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

    public getDependencies(relativePath: string, direction: 'incoming' | 'outgoing'): string[] {
        const file = this.getFile(relativePath);
        if (!file) return [];
        const rows = (direction === 'outgoing'
            ? this.statements.selectDependenciesBySource.all(file.id)
            : this.statements.selectDependenciesByTarget.all(file.id)) as Array<{ path: string }>;
        return rows.map(row => row.path);
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
        if (!file) return;
        this.statements.deleteDependenciesForSource.run(file.id);
        this.statements.deleteUnresolvedForSource.run(file.id);
    }

    private normalize(relPath: string): string {
        return relPath.replace(/\\/g, '/');
    }
}
