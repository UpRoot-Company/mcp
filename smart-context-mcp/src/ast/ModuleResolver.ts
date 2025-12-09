import * as fs from 'fs';
import * as path from 'path';
import * as resolve from 'resolve';
import { createMatchPath, loadConfig, MatchPath } from 'tsconfig-paths';

export class ModuleResolver {
    // Cache: key = "contextPath|importPath", value = resolvedPath (or null)
    private resolutionCache = new Map<string, string | null>();
    // Stat Cache: key = path, value = boolean (exists and is file)
    private fileExistsCache = new Map<string, boolean>();
    // Dir Cache: key = path, value = boolean (exists and is directory)
    private dirExistsCache = new Map<string, boolean>();

    private extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.json'];
    private rootPath: string;
    private matchPath: MatchPath | null = null;

    constructor(rootPath: string) {
        this.rootPath = rootPath;
        this.initializeTsconfigMatcher();
    }

    public resolve(contextPath: string, importPath: string): string | null {
        // 1. Check cache
        const cacheKey = JSON.stringify([contextPath, importPath]);
        if (this.resolutionCache.has(cacheKey)) {
            return this.resolutionCache.get(cacheKey)!;
        }

        let resolved: string | null = null;

        // 2. Handle Relative Paths
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
            resolved = this.resolveRelative(contextPath, importPath);
        } else if (path.isAbsolute(importPath)) {
             resolved = this.resolveFile(importPath);
        } else {
            // 3. Try TSConfig Paths Alias
            resolved = this.resolvePathsAlias(importPath);
            if (!resolved) {
                // 4. Handle Node Modules & Ambiguous Imports
                resolved = this.resolveNodeModule(contextPath, importPath);
            }
        }

        // 5. Update cache
        this.resolutionCache.set(cacheKey, resolved);
        return resolved;
    }

    private resolveRelative(contextPath: string, importPath: string): string | null {
        const dir = path.dirname(contextPath);
        const absolutePath = path.resolve(dir, importPath);
        return this.resolveFile(absolutePath);
    }

    private resolveNodeModule(contextPath: string, importPath: string): string | null {
        try {
            const res = resolve.sync(importPath, {
                basedir: path.dirname(contextPath),
                extensions: this.extensions,
                preserveSymlinks: false
            });
            return res;
        } catch (e) {
            // If resolution fails from context, try from root
            try {
                const res = resolve.sync(importPath, {
                    basedir: this.rootPath,
                    extensions: this.extensions,
                    preserveSymlinks: false
                });
                return res;
            } catch (e2) {
                return null;
            }
        }
    }

    private resolveFile(absolutePath: string): string | null {
        // Sanity check: Ensure path is within allowed bounds (if needed)
        // For now, we trust absolute paths but check existence

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

    private initializeTsconfigMatcher() {
        try {
            const configResult = loadConfig(this.rootPath);
            if (
                configResult.resultType === 'success' &&
                configResult.absoluteBaseUrl &&
                configResult.paths &&
                Object.keys(configResult.paths).length > 0
            ) {
                this.matchPath = createMatchPath(
                    configResult.absoluteBaseUrl,
                    configResult.paths,
                    configResult.mainFields,
                    configResult.addMatchAll
                );
            } else {
                this.matchPath = null;
            }
        } catch {
            this.matchPath = null;
        }
    }

    private resolvePathsAlias(importPath: string): string | null {
        if (!this.matchPath) return null;
        try {
            const matched = this.matchPath(importPath, undefined, undefined, this.extensions);
            if (!matched) {
                return null;
            }
            return this.resolveFile(matched);
        } catch {
            return null;
        }
    }

    public clearCache() {
        this.resolutionCache.clear();
        this.fileExistsCache.clear();
        this.dirExistsCache.clear();
    }
}
