import { IFileSystem } from "../platform/FileSystem.js";
import { createRequire } from "module";
import { FileVersionInfo } from "../types.js";

const require = createRequire(import.meta.url);

let importedXxhash: any = null;
try {
    importedXxhash = require("xxhashjs");
} catch (error) {
    // Fallback handled in computeHash
}

const XXH: any = importedXxhash ? ((importedXxhash as any).default ?? importedXxhash) : null;

export class FileVersionManager {
    private versions: Map<string, FileVersionInfo> = new Map();
    private fileSystem: IFileSystem;

    constructor(fileSystem: IFileSystem) {
        this.fileSystem = fileSystem;
    }

    public async getVersion(filePath: string): Promise<FileVersionInfo> {
        const cached = this.versions.get(filePath);
        const stat = await this.fileSystem.stat(filePath);

        if (!cached || cached.lastModified !== stat.mtime) {
            const content = await this.fileSystem.readFile(filePath);
            const newVersion: FileVersionInfo = {
                version: (cached?.version ?? 0) + 1,
                contentHash: this.computeHash(content),
                lastModified: stat.mtime,
                encoding: 'utf-8',
                lineEnding: this.detectLineEnding(content)
            };
            this.versions.set(filePath, newVersion);
            return newVersion;
        }

        return cached;
    }

    public incrementVersion(filePath: string, newContent: string, newMtime?: number): FileVersionInfo {
        const current = this.versions.get(filePath);
        const newVersion: FileVersionInfo = {
            version: (current?.version ?? 0) + 1,
            contentHash: this.computeHash(newContent),
            lastModified: newMtime ?? Date.now(),
            encoding: 'utf-8',
            lineEnding: this.detectLineEnding(newContent)
        };
        this.versions.set(filePath, newVersion);
        return newVersion;
    }

    public validateVersion(filePath: string, expected: { expectedVersion?: number; expectedHash?: string }): boolean {
        const current = this.versions.get(filePath);
        if (!current) {
             // If not tracked yet, we can't validate. 
             // Ideally caller should ensure version is loaded via getVersion first if they want to validate.
             return false;
        }

        if (expected.expectedVersion !== undefined && current.version !== expected.expectedVersion) {
            return false;
        }
        if (expected.expectedHash !== undefined && current.contentHash !== expected.expectedHash) {
            return false;
        }
        return true;
    }
    
    public updateLocalVersion(filePath: string, versionInfo: FileVersionInfo): void {
        this.versions.set(filePath, versionInfo);
    }

    private computeHash(content: string): string {
        if (XXH) {
            return XXH.h32(content, 0xABCD).toString(16);
        }
        // Fallback to simple hash
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16);
    }

    private detectLineEnding(content: string): 'lf' | 'crlf' {
        if (content.includes('\r\n')) return 'crlf';
        return 'lf';
    }
}
