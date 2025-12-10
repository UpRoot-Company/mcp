import * as fs from 'fs';
import * as path from 'path';
import * as resolve from 'resolve';
import { createMatchPath, loadConfig, MatchPath } from 'tsconfig-paths';

export type ModuleResolverFallback = 'node' | 'bundler';

export interface ModuleResolverConfig {
    rootPath: string;
    tsconfigPaths?: string[];
    fallbackResolution?: ModuleResolverFallback;
}

interface TsconfigMatcher {
    matchPath: MatchPath;
    configPath: string;
    absoluteBaseUrl: string;
}

export interface ResolutionAttempt {
    strategy: 'relative' | 'absolute' | 'alias' | 'node' | 'bundler';
    detail?: string;
}

export interface ResolutionResult {
    resolvedPath: string | null;
    strategy: ResolutionAttempt['strategy'] | 'unresolved';
    attempts: ResolutionAttempt[];
    error?: string;
    metadata?: Record<string, string>;
}

export class ModuleResolver {
    // Cache: key = "contextPath|importPath", value = detailed resolution result
    private resolutionCache = new Map<string, ResolutionResult>();
    // Stat Cache: key = path, value = boolean (exists and is file)
    private fileExistsCache = new Map<string, boolean>();
    // Dir Cache: key = path, value = boolean (exists and is directory)
    private dirExistsCache = new Map<string, boolean>();

    private extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.json'];
    private rootPath: string;
    private tsconfigMatchers: TsconfigMatcher[] = [];
    private fallback: ModuleResolverFallback;

    constructor(config: string | ModuleResolverConfig) {
        if (typeof config === 'string') {
            this.rootPath = config;
            this.fallback = 'node';
        } else {
            this.rootPath = config.rootPath;
            this.fallback = config.fallbackResolution || 'node';
            if (config.tsconfigPaths && config.tsconfigPaths.length > 0) {
                this.initializeTsconfigMatchers(config.tsconfigPaths);
            }
        }

        if (this.tsconfigMatchers.length === 0) {
            this.initializeTsconfigMatchers();
        }
    }

    public resolve(contextPath: string, importPath: string): string | null {
        return this.resolveDetailed(contextPath, importPath).resolvedPath;
    }

    public resolveDetailed(contextPath: string, importPath: string): ResolutionResult {
        const cacheKey = JSON.stringify([contextPath, importPath]);
        if (this.resolutionCache.has(cacheKey)) {
            return this.resolutionCache.get(cacheKey)!;
        }

        const attempts: ResolutionAttempt[] = [];
        let resolved: string | null = null;
        let strategy: ResolutionResult['strategy'] = 'unresolved';
        let metadata: Record<string, string> | undefined;

        const recordAttempt = (attempt: ResolutionAttempt) => attempts.push(attempt);

        if (importPath.startsWith('./') || importPath.startsWith('../')) {
            recordAttempt({ strategy: 'relative' });
            resolved = this.resolveRelative(contextPath, importPath);
            if (resolved) strategy = 'relative';
        } else if (path.isAbsolute(importPath)) {
            recordAttempt({ strategy: 'absolute' });
            resolved = this.resolveFile(importPath);
            strategy = resolved ? 'absolute' : 'unresolved';
        } else {
            const aliasResult = this.resolvePathsAlias(importPath);
            if (aliasResult) {
                recordAttempt({ strategy: 'alias', detail: aliasResult.configPath });
                resolved = aliasResult.resolvedPath;
                strategy = resolved ? 'alias' : 'unresolved';
                metadata = { configPath: aliasResult.configPath };
            } else {
                recordAttempt({ strategy: 'alias' });
            }

            if (!resolved) {
                recordAttempt({ strategy: 'node' });
                resolved = this.resolveNodeModule(contextPath, importPath);
                if (resolved) {
                    strategy = 'node';
                }
            }

            if (!resolved && this.fallback === 'bundler') {
                recordAttempt({ strategy: 'bundler' });
                resolved = this.resolveBundlerLike(importPath);
                if (resolved) {
                    strategy = 'bundler';
                }
            }
        }

        if (strategy === 'unresolved') {
            metadata = metadata || {};
            metadata.reason = `Unresolved after attempts: ${attempts.map(a => a.strategy).join(', ')}`;
        }

        const result: ResolutionResult = {
            resolvedPath: resolved,
            strategy,
            attempts,
            error: resolved ? undefined : 'Module resolution failed',
            metadata
        };

        this.resolutionCache.set(cacheKey, result);

        return result;
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

    private resolveBundlerLike(importPath: string): string | null {
        if (importPath.startsWith('.') || importPath.startsWith('/')) return null;

        const baseCandidates = new Set<string>([this.rootPath]);
        for (const matcher of this.tsconfigMatchers) {
            baseCandidates.add(matcher.absoluteBaseUrl);
        }

        for (const base of baseCandidates) {
            const candidate = path.join(base, importPath);
            const resolved = this.resolveFile(candidate);
            if (resolved) {
                return resolved;
            }
        }

        return null;
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

    private initializeTsconfigMatchers(explicitPaths?: string[]) {
        this.tsconfigMatchers = [];
        const candidates = explicitPaths && explicitPaths.length > 0
            ? explicitPaths
            : this.discoverTsconfigPaths();
        const seen = new Set<string>();

        for (const candidate of candidates) {
            const configPath = path.isAbsolute(candidate) ? candidate : path.join(this.rootPath, candidate);
            if (!fs.existsSync(configPath)) continue;
            const normalized = configPath;
            if (seen.has(normalized)) continue;
            seen.add(normalized);

            try {
                const configResult = loadConfig(normalized);
                if (
                    configResult.resultType === 'success' &&
                    configResult.absoluteBaseUrl &&
                    configResult.paths &&
                    Object.keys(configResult.paths).length > 0
                ) {
                    const matchPath = createMatchPath(
                        configResult.absoluteBaseUrl,
                        configResult.paths,
                        configResult.mainFields,
                        configResult.addMatchAll
                    );
                    this.tsconfigMatchers.push({
                        matchPath,
                        configPath: configResult.configFileAbsolutePath || normalized,
                        absoluteBaseUrl: configResult.absoluteBaseUrl
                    });
                }
            } catch (error) {
                // Ignore malformed configs while keeping resolver functional
            }
        }
    }

    private discoverTsconfigPaths(): string[] {
        const defaults = new Set<string>();
        const rootFiles = fs.existsSync(this.rootPath) ? fs.readdirSync(this.rootPath) : [];
        for (const file of rootFiles) {
            if (file.startsWith('tsconfig') && file.endsWith('.json')) {
                defaults.add(path.join(this.rootPath, file));
            }
        }

        const candidateDirs = ['packages', 'apps', 'libs', 'services'];
        for (const dir of candidateDirs) {
            const full = path.join(this.rootPath, dir);
            if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
            for (const sub of fs.readdirSync(full)) {
                const tsconfigPath = path.join(full, sub, 'tsconfig.json');
                if (fs.existsSync(tsconfigPath)) {
                    defaults.add(tsconfigPath);
                }
            }
        }

        const direct = path.join(this.rootPath, 'tsconfig.json');
        if (fs.existsSync(direct)) {
            defaults.add(direct);
        }

        return Array.from(defaults);
    }

    private resolvePathsAlias(importPath: string): { resolvedPath: string | null; configPath: string } | null {
        if (this.tsconfigMatchers.length === 0) return null;
        for (const matcher of this.tsconfigMatchers) {
            try {
                const matched = matcher.matchPath(importPath, undefined, undefined, this.extensions);
                if (!matched) {
                    continue;
                }
                const resolved = this.resolveFile(matched);
                if (resolved) {
                    return { resolvedPath: resolved, configPath: matcher.configPath };
                }
            } catch {
                continue;
            }
        }
        return null;
    }

    public clearCache() {
        this.resolutionCache.clear();
        this.fileExistsCache.clear();
        this.dirExistsCache.clear();
    }
}
