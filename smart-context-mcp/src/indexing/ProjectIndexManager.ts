import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import { ProjectIndex, FileIndexEntry } from './ProjectIndex.js';
import { PathManager } from '../utils/PathManager.js';

const CURRENT_INDEX_VERSION = '1.1.0';

/**
 * Manages persistent project index storage and retrieval
 */
export class ProjectIndexManager {
  private projectRoot: string;
  private indexPath: string;
  
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.indexPath = this.resolveExistingIndexPath();
  }
  
  private resolveExistingIndexPath(): string {
    const unifiedIndexPath = path.join(PathManager.getIndexDir(), 'index.json');
    const preferredIndexPath = path.join(this.projectRoot, '.mcp', 'smart-context', 'index.json');
    const legacyIndexPath = path.join(this.projectRoot, '.smart-context-index', 'index.json');

    if (fssync.existsSync(unifiedIndexPath)) {
      return unifiedIndexPath;
    }
    if (fssync.existsSync(preferredIndexPath)) {
      return preferredIndexPath;
    }
    if (fssync.existsSync(legacyIndexPath)) {
      return legacyIndexPath;
    }
    return unifiedIndexPath;
  }

  /**
   * Load persisted index from disk
   * Returns null if index doesn't exist or version mismatch
   */
  async loadPersistedIndex(): Promise<ProjectIndex | null> {
    try {
      this.indexPath = this.resolveExistingIndexPath();
      await fs.access(this.indexPath);
      
      const data = await fs.readFile(this.indexPath, 'utf-8');
      const index: ProjectIndex = JSON.parse(data);
      
      if (index.version !== CURRENT_INDEX_VERSION) {
        console.log(`[ProjectIndex] Version mismatch: ${index.version} vs ${CURRENT_INDEX_VERSION}, rebuilding...`);
        return null;
      }

      if (index.projectRoot !== this.projectRoot) {
        console.log(`[ProjectIndex] Project root mismatch, rebuilding...`);
        return null;
      }

      console.log(`[ProjectIndex] Loaded existing index with ${Object.keys(index.files).length} files`);
      return index;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        console.log('[ProjectIndex] No existing index found, will build from scratch');
      } else {
        console.error('[ProjectIndex] Error loading index:', error);
      }
      return null;
    }
  }

  /**
   * Persist current index to disk
   */
  async persistIndex(index: ProjectIndex): Promise<void> {
    try {
      const targetPath = path.join(PathManager.getIndexDir(), 'index.json');
      const json = JSON.stringify(index, null, 2);

      // Ensure directory exists
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, json, 'utf-8');
      this.indexPath = targetPath;
      
      console.log(`[ProjectIndex] Persisted index with ${Object.keys(index.files).length} files`);
    } catch (error) {
      console.error('[ProjectIndex] Error persisting index:', error);
    }
  }
  
  /**
   * Get list of files that changed since last index
   * Returns all files if no index exists (full rebuild)
   */
  async getChangedFilesSinceLastIndex(
    currentFiles: string[]
  ): Promise<{ changed: string[]; unchanged: string[] }> {
    const index = await this.loadPersistedIndex();
    // No index → full rebuild
    if (!index) {
      return { changed: currentFiles, unchanged: [] };
    }

    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const file of currentFiles) {
      try {
        const stat = await fs.stat(file);
        const indexedEntry = index.files[file];
        
        if (!indexedEntry || stat.mtimeMs > indexedEntry.mtime) {
          changed.push(file);
        } else {
          unchanged.push(file);
        }
      } catch (e) {
        changed.push(file);
      }
    }

    console.log(`[ProjectIndex] Changed: ${changed.length}, Unchanged: ${unchanged.length}`);
    return { changed, unchanged };
  }
  
  /**
   * Create new empty index structure
   */
  createEmptyIndex(): ProjectIndex {
    return {
      version: CURRENT_INDEX_VERSION,
      projectRoot: this.projectRoot,
      lastUpdate: Date.now(),
      files: {},
      symbolIndex: {},
      reverseImports: {}
    };
  }
  
  /**
   * Update index entry for a single file
   */
  updateFileEntry(
    index: ProjectIndex,
    filePath: string,
    entry: FileIndexEntry
  ): void {
    index.files[filePath] = entry;
    index.lastUpdate = Date.now();

    // Update symbol index
    for (const symbol of entry.symbols) {
      if (!index.symbolIndex[symbol.name]) {
        index.symbolIndex[symbol.name] = [];
      }
      if (!index.symbolIndex[symbol.name].includes(filePath)) {
        index.symbolIndex[symbol.name].push(filePath);
      }
    }

    // Update reverse imports
    for (const imp of entry.imports) {
      if (imp.resolvedPath) {
        if (!index.reverseImports[imp.resolvedPath]) {
          index.reverseImports[imp.resolvedPath] = [];
        }
        if (!index.reverseImports[imp.resolvedPath].includes(filePath)) {
          index.reverseImports[imp.resolvedPath].push(filePath);
        }
      }
    }
  }
  
  /**
   * Remove file from index (e.g., when deleted)
   */
  removeFileEntry(index: ProjectIndex, filePath: string): void {
    const entry = index.files[filePath];
    if (!entry) return;

    // Remove from symbol index
    for (const symbol of entry.symbols) {
      const paths = index.symbolIndex[symbol.name];
      if (paths) {
        index.symbolIndex[symbol.name] = paths.filter(p => p !== filePath);
        if (index.symbolIndex[symbol.name].length === 0) {
          delete index.symbolIndex[symbol.name];
        }
      }
    }

    // Remove from reverse imports
    for (const imp of entry.imports) {
      if (imp.resolvedPath) {
        const paths = index.reverseImports[imp.resolvedPath];
        if (paths) {
          index.reverseImports[imp.resolvedPath] = paths.filter(p => p !== filePath);
          if (index.reverseImports[imp.resolvedPath].length === 0) {
            delete index.reverseImports[imp.resolvedPath];
          }
        }
      }
    }

    delete index.files[filePath];
    index.lastUpdate = Date.now();
  }
}
