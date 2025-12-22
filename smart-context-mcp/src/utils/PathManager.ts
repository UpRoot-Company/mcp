import * as path from 'path';
import * as os from 'os';

/**
 * Standardizes all data paths used by Smart-Context-MCP.
 * Root is typically '.smart-context/' at the project root.
 */
export class PathManager {
    private static baseDir = PathManager.resolveBaseDir();
    private static rootPath: string = process.cwd();

    /**
     * Explicitly sets the project root path for all subsequent path resolutions.
     */
    static setRoot(root: string) {
        this.rootPath = path.resolve(root);
    }

    private static resolveBaseDir(): string {
        const raw = (process.env.SMART_CONTEXT_DIR || '').trim();
        if (!raw) {
            return '.smart-context';
        }

        const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
        const allowLegacy = process.env.SMART_CONTEXT_ALLOW_LEGACY_MCP_DIR === 'true';
        if (!allowLegacy) {
            if (normalized === '.mcp' || normalized === '.mcp/smart-context') {
                console.warn('[PathManager] SMART_CONTEXT_DIR points to deprecated .mcp path; using .smart-context instead.');
                return '.smart-context';
            }
            if (normalized.includes('/.mcp/')) {
                console.warn('[PathManager] SMART_CONTEXT_DIR points to deprecated .mcp path; using .smart-context instead.');
                return '.smart-context';
            }
        }

        return raw;
    }

    /**
     * Resolves a path relative to the unified .smart-context directory.
     */
    static resolve(...segments: string[]): string {
        return path.join(this.rootPath, this.baseDir, ...segments);
    }

    // --- Operational Data Paths ---

    static getIndexDir() {
        return this.resolve('data', 'index');
    }

    static getCacheDir() {
        return this.resolve('data', 'cache');
    }

    static getHistoryDir() {
        return this.resolve('data', 'history');
    }

    static getBackupDir() {
        return path.join(this.getHistoryDir(), 'backups');
    }

    static getLogPath() {
        return path.join(this.getHistoryDir(), 'transactions.db');
    }

    // --- Configuration Paths ---

    static getConfigDir() {
        return this.resolve('config');
    }

    // --- Ephemeral/Temp Paths ---

    static getTempDir() {
        return this.resolve('temp');
    }

    static getTestRootDir() {
        return path.join(this.getTempDir(), 'tests');
    }

    static getBenchmarkRootDir() {
        return path.join(this.getTempDir(), 'benchmarks');
    }

    /**
     * Generates a unique, isolated directory for a specific test run.
     */
    static getTestRunDir(id: string = Date.now().toString()) {
        return path.join(this.getTestRootDir(), `run_${id}`);
    }
}
