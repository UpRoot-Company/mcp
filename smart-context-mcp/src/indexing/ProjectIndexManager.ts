import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectIndex, FileIndexEntry } from './ProjectIndex.js';

const CURRENT_INDEX_VERSION = '1.0.0';

/**
 * Manages persistent project index storage and retrieval
 */
export class ProjectIndexManager {
  private projectRoot: string;
  private indexPath: string;
  
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.indexPath = path.join(projectRoot, '.smart-context', 'index.json');
  }
  
  /**
   * Load persisted index from disk
   * Returns null if index doesn't exist or version mismatch
   */
  async loadPersistedIndex(): Promise<ProjectIndex | null> {
    try {
      // Check if index file exists
      await fs.access(this.indexPath);
      
      // Read and parse JSON
      const data = await fs.readFile(this.indexPath, 'utf-8');
      const index: ProjectIndex = JSON.parse(data);
      
      // Validate version compatibility
      if (index.version !== CURRENT_INDEX_VERSION) {
        console.log(`[ProjectIndex] Version mismatch: ${index.version} vs ${CURRENT_INDEX_VERSION}, rebuilding...`);
        return null;
      }
      
      // Validate project root matches
      if (index.projectRoot !== this.projectRoot) {
        console.log(`[ProjectIndex] Project root mismatch, rebuilding...`);
        return null;
      }
      
      console.log(`[ProjectIndex] Loaded existing index with ${Object.keys(index.files).length} files`);
      return index;
      
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[ProjectIndex] No existing index found, will build from scratch');
        return null;
      }
      console.error('[ProjectIndex] Error loading index:', error);
      return null;
    }
  }
  
  /**
   * Persist current index to disk
   */
  async persistIndex(index: ProjectIndex): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
      
      // Write JSON with pretty formatting (for debugging)
      const json = JSON.stringify(index, null, 2);
      await fs.writeFile(this.indexPath, json, 'utf-8');
      
      console.log(`[ProjectIndex] Persisted index with ${Object.keys(index.files).length} files`);
      
    } catch (error) {
      console.error('[ProjectIndex] Error persisting index:', error);
      throw error;
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
        
        // New file (not in index)
        if (!indexedEntry) {
          changed.push(file);
          continue;
        }
        
        // File modified (mtime changed)
        if (stat.mtimeMs > indexedEntry.mtime) {
          changed.push(file);
          continue;
        }
        
        // File unchanged
        unchanged.push(file);
        
      } catch (error) {
        // File stat failed → treat as changed (safe fallback)
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
      if (!index.reverseImports[imp.from]) {
        index.reverseImports[imp.from] = [];
      }
      if (!index.reverseImports[imp.from].includes(filePath)) {
        index.reverseImports[imp.from].push(filePath);
      }
    }
  }
  
  /**
   * Remove file from index (e.g., when deleted)
   */
  removeFileEntry(index: ProjectIndex, filePath: string): void {
    const entry = index.files[filePath];
    if (!entry) return;
    
    // Remove from files map
    delete index.files[filePath];
    
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
      const paths = index.reverseImports[imp.from];
      if (paths) {
        index.reverseImports[imp.from] = paths.filter(p => p !== filePath);
        if (index.reverseImports[imp.from].length === 0) {
          delete index.reverseImports[imp.from];
        }
      }
    }
    
    index.lastUpdate = Date.now();
  }
}
