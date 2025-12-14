import * as path from "path";
import { promises as fsPromises, constants as fsConstants, watch as fsWatch } from "fs";

export type FileChangeType = "create" | "update" | "delete";

export interface FileChangeEvent {
    path: string;
    type: FileChangeType;
}

export interface FileStats {
    size: number;
    mtime: number;
    isDirectory(): boolean;
}

export interface IFileSystem {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    deleteFile(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    readDir(path: string): Promise<string[]>;
    createDir(path: string): Promise<void>;
    stat(path: string): Promise<FileStats>;
    watch?(path: string, onChange: (event: FileChangeEvent) => void): () => void;

    listFiles(basePath: string): Promise<string[]>;}

export class NodeFileSystem implements IFileSystem {
    private readonly rootPath: string;

    constructor(rootPath: string) {
        this.rootPath = path.resolve(rootPath);
    }

    private resolvePath(targetPath: string): string {
        if (!targetPath) {
            return this.rootPath;
        }
        return path.isAbsolute(targetPath)
            ? path.normalize(targetPath)
            : path.join(this.rootPath, targetPath);
    }

    async readFile(targetPath: string): Promise<string> {
        return fsPromises.readFile(this.resolvePath(targetPath), "utf-8");
    }

    async writeFile(targetPath: string, content: string): Promise<void> {
        await fsPromises.writeFile(this.resolvePath(targetPath), content, "utf-8");
    }

    async rename(from: string, to: string): Promise<void> {
        const fromResolved = this.resolvePath(from);
        const toResolved = this.resolvePath(to);
        await fsPromises.rename(fromResolved, toResolved);
    }

    async deleteFile(targetPath: string): Promise<void> {
        const resolved = this.resolvePath(targetPath);
        try {
            await fsPromises.unlink(resolved);
        } catch (error: any) {
            if (error?.code === "EISDIR" || error?.code === "EPERM") {
                await fsPromises.rm(resolved, { recursive: true, force: true });
                return;
            }
            throw error;
        }
    }

    async exists(targetPath: string): Promise<boolean> {
        try {
            await fsPromises.access(this.resolvePath(targetPath), fsConstants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    async readDir(targetPath: string): Promise<string[]> {
        return fsPromises.readdir(this.resolvePath(targetPath));
    }

    async createDir(targetPath: string): Promise<void> {
        await fsPromises.mkdir(this.resolvePath(targetPath), { recursive: true });
    }

    async stat(targetPath: string): Promise<FileStats> {
        const stats = await fsPromises.stat(this.resolvePath(targetPath));
        return {
            size: stats.size,
            mtime: stats.mtimeMs,
            isDirectory: () => stats.isDirectory(),
        };
    }

    watch(targetPath: string, onChange: (event: FileChangeEvent) => void): () => void {
        const resolved = this.resolvePath(targetPath);
        const watcher = fsWatch(resolved, (eventType, filename) => {
            const change: FileChangeType = eventType === "rename" ? "update" : "update";
            const affected = filename ? path.join(resolved, filename.toString()) : resolved;
            onChange({ path: affected, type: change });
        });
        return () => watcher.close();
    }

    async listFiles(basePath: string): Promise<string[]> {
        let results: string[] = [];
        const resolvedBasePath = this.resolvePath(basePath); // Use resolvePath for safety
        const filesAndDirs = await this.readDir(resolvedBasePath);

        for (const entry of filesAndDirs) {
            const entryPath = path.join(resolvedBasePath, entry);
            let stats: FileStats;
            try {
                stats = await this.stat(entryPath);
            } catch {
                continue;
            }

            if (stats.isDirectory()) {
                results = results.concat(await this.listFiles(entryPath)); // Recursive call
            } else {
                results.push(entryPath);
            }
        }
        return results;
    }
}

interface MemoryFileEntry {
    content: string;
    mtime: number;
}

interface MemoryDirectoryEntry {
    mtime: number;
}

type Watcher = {
    path: string;
    callback: (event: FileChangeEvent) => void;
};

export class MemoryFileSystem implements IFileSystem {
    private readonly rootPath: string;
    private readonly files = new Map<string, MemoryFileEntry>();
    private readonly directories = new Map<string, MemoryDirectoryEntry>();
    private readonly watchers = new Map<number, Watcher>();
    private watcherSeq = 0;

    constructor(rootPath: string = process.cwd()) {
        this.rootPath = path.resolve(rootPath);
        this.directories.set(this.rootPath, { mtime: Date.now() });
    }

    private resolvePath(targetPath: string): string {
        if (!targetPath) {
            return this.rootPath;
        }
        return path.isAbsolute(targetPath)
            ? path.normalize(targetPath)
            : path.join(this.rootPath, targetPath);
    }

    private ensureParentDirectories(targetPath: string): void {
        let current = path.dirname(targetPath);
        while (!this.directories.has(current)) {
            this.directories.set(current, { mtime: Date.now() });
            const next = path.dirname(current);
            if (next === current) {
                break;
            }
            current = next;
        }
    }

    private notifyWatchers(targetPath: string, type: FileChangeType): void {
        for (const watcher of this.watchers.values()) {
            if (targetPath.startsWith(watcher.path)) {
                watcher.callback({ path: targetPath, type });
            }
        }
    }

    async readFile(targetPath: string): Promise<string> {
        const resolved = this.resolvePath(targetPath);
        const entry = this.files.get(resolved);
        if (!entry) {
            throw new Error(`ENOENT: no such file, open '${resolved}'`);
        }
        return entry.content;
    }

    async writeFile(targetPath: string, content: string): Promise<void> {
        const resolved = this.resolvePath(targetPath);
        this.ensureParentDirectories(resolved);
        const parent = path.dirname(resolved);
        this.directories.set(parent, { mtime: Date.now() });
        const existed = this.files.has(resolved);
        this.files.set(resolved, {
            content,
            mtime: Date.now(),
        });
        this.notifyWatchers(resolved, existed ? "update" : "create");
    }

    async rename(from: string, to: string): Promise<void> {
        const fromResolved = this.resolvePath(from);
        const toResolved = this.resolvePath(to);

        if (this.files.has(fromResolved)) {
            const entry = this.files.get(fromResolved)!;
            this.files.delete(fromResolved);
            this.files.set(toResolved, { ...entry, mtime: Date.now() });
            this.notifyWatchers(toResolved, "update");
            return;
        }

        if (this.directories.has(fromResolved)) {
            const entry = this.directories.get(fromResolved)!;
            this.directories.delete(fromResolved);
            this.directories.set(toResolved, { ...entry, mtime: Date.now() });
            this.notifyWatchers(toResolved, "update");
            return;
        }

        throw new Error(`ENOENT: no such file or directory, rename '${fromResolved}' -> '${toResolved}'`);
    }

    async deleteFile(targetPath: string): Promise<void> {
        const resolved = this.resolvePath(targetPath);
        if (!this.files.delete(resolved)) {
            throw new Error(`ENOENT: no such file, unlink '${resolved}'`);
        }
        this.notifyWatchers(resolved, "delete");
    }

    async exists(targetPath: string): Promise<boolean> {
        const resolved = this.resolvePath(targetPath);
        return this.files.has(resolved) || this.directories.has(resolved);
    }

    async readDir(targetPath: string): Promise<string[]> {
        const resolved = this.resolvePath(targetPath);
        if (!this.directories.has(resolved)) {
            throw new Error(`ENOENT: no such directory, scandir '${resolved}'`);
        }
        const entries = new Set<string>();
        for (const filePath of this.files.keys()) {
            if (path.dirname(filePath) === resolved) {
                entries.add(path.basename(filePath));
            }
        }
        for (const dirPath of this.directories.keys()) {
            if (dirPath === resolved) continue;
            if (path.dirname(dirPath) === resolved) {
                entries.add(path.basename(dirPath));
            }
        }
        return Array.from(entries.values()).sort();
    }

    async createDir(targetPath: string): Promise<void> {
        const resolved = this.resolvePath(targetPath);
        this.ensureParentDirectories(resolved);
        const existed = this.directories.has(resolved);
        this.directories.set(resolved, { mtime: Date.now() });
        this.notifyWatchers(resolved, existed ? "update" : "create");
    }

    async stat(targetPath: string): Promise<FileStats> {
        const resolved = this.resolvePath(targetPath);
        if (this.files.has(resolved)) {
            const entry = this.files.get(resolved)!;
            return {
                size: Buffer.byteLength(entry.content, "utf-8"),
                mtime: entry.mtime,
                isDirectory: () => false,
            };
        }
        if (this.directories.has(resolved)) {
            const entry = this.directories.get(resolved)!;
            return {
                size: 0,
                mtime: entry.mtime,
                isDirectory: () => true,
            };
        }
        throw new Error(`ENOENT: no such file or directory, stat '${resolved}'`);
    }

    watch(targetPath: string, onChange: (event: FileChangeEvent) => void): () => void {
        const resolved = this.resolvePath(targetPath);
        const id = ++this.watcherSeq;
        this.watchers.set(id, { path: resolved, callback: onChange });
        return () => {
            this.watchers.delete(id);
        };
    }

    async listFiles(basePath: string): Promise<string[]> {
        const resolvedBasePath = this.resolvePath(basePath);
        const results: string[] = [];

        // Collect files
        for (const filePath of this.files.keys()) {
            if (filePath.startsWith(resolvedBasePath) && !this.directories.has(filePath)) {
                results.push(filePath);
            }
        }

        // Recursively collect from subdirectories
        for (const dirPath of this.directories.keys()) {
            if (dirPath.startsWith(resolvedBasePath) && dirPath !== resolvedBasePath) {
                // Check if dirPath is a direct child of resolvedBasePath
                const relativePath = path.relative(resolvedBasePath, dirPath);
                if (!relativePath.includes(path.sep)) { // Direct child directory
                    results.push(...await this.listFiles(dirPath));
                }
            }
        }
        return results;
    }
}
