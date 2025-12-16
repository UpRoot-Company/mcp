import { SymbolInfo } from '../types.js';

/**
 * Persistent project-wide index structure
 * Stored as JSON at: <projectRoot>/.smart-context-index/index.json
 */
export interface ProjectIndex {
  /** Index format version (for migration compatibility) */
  version: string;
  
  /** Absolute path to project root */
  projectRoot: string;
  
  /** Timestamp of last index update (Unix ms) */
  lastUpdate: number;
  
  /** Per-file index entries */
  files: Record<string, FileIndexEntry>;
  
  /** Symbol name → file paths (for quick symbol lookup) */
  symbolIndex: Record<string, string[]>;
  
  /** File → files that import it (reverse dependency map) */
  reverseImports: Record<string, string[]>;
}

/**
 * Index entry for a single file
 */
export interface FileIndexEntry {
  /** File modification time (Unix ms) - for staleness detection */
  mtime: number;
  
  /** Extracted symbols (classes, functions, types, etc.) */
  symbols: SymbolInfo[];
  
  /** Parsed imports from this file */
  imports: ImportInfo[];
  
  /** Parsed exports from this file */
  exports: ExportInfo[];
  
  /** Trigram statistics (for search optimization) */
  trigrams?: {
    wordCount: number;
    uniqueTrigramCount: number;
  };
}

export interface ImportInfo {
  /** Resolved absolute path to imported file */
  from: string;
  
  /** Imported identifiers (e.g., ["Foo", "Bar"] for named imports) */
  what: string[];
  
  /** Line number of import statement */
  line: number;
  
  /** Import type: 'named' | 'default' | 'namespace' | 'side-effect' */
  importType: 'named' | 'default' | 'namespace' | 'side-effect';
}

export interface ExportInfo {
  /** Exported identifier name */
  name: string;
  
  /** Export type: 'named' | 'default' */
  exportType: 'named' | 'default';
  
  /** Line number of export statement */
  line: number;
  
  /** True if this is a re-export (export { X } from './foo') */
  isReExport: boolean;
  
  /** Source file if re-export */
  reExportFrom?: string;
}
