import type { ImportInfo } from '../indexing/ProjectIndex.js';

/**
 * Maintains a reverse index: file → files that import it
 * Enables efficient "who imports this file?" queries
 */
export class ReverseImportIndex {
  // Map: importedFile → Set of files that import it
  private index = new Map<string, Set<string>>();
  
  /**
   * Build complete reverse index from project files and their imports
   */
  buildIndex(
    projectFiles: Map<string, ImportInfo[]>
  ): void {
    this.index.clear();
    
    for (const [filePath, imports] of projectFiles.entries()) {
      for (const imp of imports) {
        if (!imp.resolvedPath) {
          continue;
        }
        if (!this.index.has(imp.resolvedPath)) {
          this.index.set(imp.resolvedPath, new Set());
        }
        this.index.get(imp.resolvedPath)!.add(filePath);
      }
    }
    
    console.log(`[ReverseImportIndex] Built index for ${this.index.size} imported files`);
  }
  
  /**
   * Add single import relationship to index
   */
  addImport(importerFile: string, importedFile: string): void {
    if (!this.index.has(importedFile)) {
      this.index.set(importedFile, new Set());
    }
    this.index.get(importedFile)!.add(importerFile);
  }
  
  /**
   * Remove all imports from a file (e.g., when file deleted)
   */
  removeImporter(importerFile: string): void {
    for (const importedFileSet of this.index.values()) {
      importedFileSet.delete(importerFile);
    }
  }
  
  /**
   * Get all files that import the target file
   */
  getImporters(targetFile: string): string[] {
    return Array.from(this.index.get(targetFile) || []);
  }
  
  /**
   * Check if a file has any importers
   */
  hasImporters(targetFile: string): boolean {
    const importers = this.index.get(targetFile);
    return !!importers && importers.size > 0;
  }
  
  /**
   * Get count of importers for a file
   */
  getImporterCount(targetFile: string): number {
    return this.index.get(targetFile)?.size || 0;
  }
  
  /**
   * Clear entire index
   */
  clear(): void {
    this.index.clear();
  }
  
  /**
   * Get all files in the index (all files that are imported by something)
   */
  getAllImportedFiles(): string[] {
    return Array.from(this.index.keys());
  }
}
