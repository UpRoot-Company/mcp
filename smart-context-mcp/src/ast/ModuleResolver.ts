import * as fs from 'fs';
import * as path from 'path';

export class ModuleResolver {
    // Cache: key = "contextPath|importPath", value = resolvedPath (or null)
    private resolutionCache = new Map<string, string | null>();
    // Stat Cache: key = path, value = boolean (exists and is file)
    private fileExistsCache = new Map<string, boolean>();
    // Dir Cache: key = path, value = boolean (exists and is directory)
    private dirExistsCache = new Map<string, boolean>();

    private extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.json'];

    constructor() {}

    public resolve(contextPath: string, importPath: string): string | null {
        // 1. Check cache
        const cacheKey = `${contextPath}|${importPath}`;
        if (this.resolutionCache.has(cacheKey)) {
            return this.resolutionCache.get(cacheKey)!;
        }

        let resolved: string | null = null;

        // 2. Handle Relative Paths
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
            resolved = this.resolveRelative(contextPath, importPath);
        } else if (path.isAbsolute(importPath)) {
             resolved = this.resolveFile(importPath);
        }
        // TODO: Handle 'paths' alias or node_modules in future

        // 3. Update cache
        this.resolutionCache.set(cacheKey, resolved);
        return resolved;
    }

    private resolveRelative(contextPath: string, importPath: string): string | null {
        const dir = path.dirname(contextPath);
        const absolutePath = path.resolve(dir, importPath);
        return this.resolveFile(absolutePath);
    }

    private resolveFile(absolutePath: string): string | null {
        // 1. Exact match?
        if (this.isFile(absolutePath)) return absolutePath;

        // 2. Try extensions
        for (const ext of this.extensions) {
            if (this.isFile(absolutePath + ext)) return absolutePath + ext;
        }

        // 3. Try directory index
        if (this.isDirectory(absolutePath)) {
            for (const ext of this.extensions) {
                const indexPath = path.join(absolutePath, `index${ext}`);
                if (this.isFile(indexPath)) return indexPath;
            }
        }

        return null;
    }

    private isFile(filePath: string): boolean {
        if (this.fileExistsCache.has(filePath)) {
            return this.fileExistsCache.get(filePath)!;
        }
        try {
            const stat = fs.statSync(filePath);
            const isFile = stat.isFile();
            this.fileExistsCache.set(filePath, isFile);
            return isFile;
        } catch (e) {
            this.fileExistsCache.set(filePath, false);
            return false;
        }
    }

    private isDirectory(dirPath: string): boolean {
        if (this.dirExistsCache.has(dirPath)) {
            return this.dirExistsCache.get(dirPath)!;
        }
        try {
            const stat = fs.statSync(dirPath);
            const isDir = stat.isDirectory();
            this.dirExistsCache.set(dirPath, isDir);
            return isDir;
        } catch (e) {
            this.dirExistsCache.set(dirPath, false);
            return false;
        }
    }
    
    public clearCache() {
        this.resolutionCache.clear();
        this.fileExistsCache.clear();
        this.dirExistsCache.clear();
    }
}
