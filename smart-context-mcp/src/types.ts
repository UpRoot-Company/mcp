
export interface FileSearchResult {
    filePath: string;
    lineNumber: number;
    preview: string;
    score?: number;
}

export interface ReadFragmentResult {
    filePath: string;
    content: string;
    ranges: LineRange[];
}

export interface LineRange {
    start: number;
    end: number;
}

export interface ErrorDetails {
    conflictingLines?: number[];
}

export interface IndexRange {
    start: number;
    end: number;
}

export interface Edit {
    targetString: string;
    replacementString: string;
    lineRange?: LineRange;
    /**
     * Optional absolute character range within the file content.
     * When provided, editors can perform precise, index-based replacements
     * without needing fuzzy search or context matching.
     */
    indexRange?: IndexRange;
    beforeContext?: string;
    afterContext?: string;
    fuzzyMode?: "whitespace" | "levenshtein";
    anchorSearchRange?: { lines: number, chars: number };
}

export interface EditResult {
    success: boolean;
    message?: string;
    diff?: string;
    structuredDiff?: { filePath: string; diff: string; added: number; removed: number }[];
    originalContent?: string;
    newContent?: string;
    details?: ErrorDetails;
    suggestion?: string;
    errorCode?: string;
    /**
     * Metadata about the edit operation, including inverse edits for undo.
     */
    operation?: EditOperation;
}

export interface EditOperation {
    /**
     * The file this operation applies to, typically stored
     * as a path relative to the SmartContextServer root.
     */
    filePath?: string;
    /**
     * Unique identifier for this edit operation (UUID).
     */
    id: string;
    /**
     * Milliseconds since epoch when the operation was created.
     */
    timestamp: number;
    /**
     * Human-readable description of the operation (e.g. tool name or intent).
     */
    description: string;
    /**
     * The original edits that were applied to the file.
     */
    edits: Edit[];
    /**
     * The inverse edits that can be used to undo this operation.
     */
    inverseEdits: Edit[];
}

export interface BatchOperation {
    id: string;
    timestamp: number;
    description: string;
    operations: EditOperation[];
}

export type HistoryItem = EditOperation | BatchOperation;

export interface DirectoryTree {
    [key: string]: null | DirectoryTree;
}

export interface Document {
    id: string; // Document ID (e.g. filePath)
    text: string; // The text content of the document
    score: number; // BM25 score
}

export interface FileMatch {
    path: string;
    matches: {
        line: number;
        text: string;
    }[];
}

export interface ISearchProvider {
    (pattern: string, options: { cwd: string; exclude?: string[]; include?: string[] }): Promise<FileMatch[]>;
}

export interface ScoutResult {
    matches: FileMatch[];
    truncated: boolean;
    errors: string[];
}

export interface BaseSymbolInfo {
    name: string;
    range: { startLine: number; endLine: number; startByte: number; endByte: number };
    container?: string;
    modifiers?: string[];
    doc?: string;
}

export interface DefinitionSymbol extends BaseSymbolInfo {
    type: 'class' | 'function' | 'method' | 'interface' | 'variable';
    signature?: string;
    parameters?: string[];
    returnType?: string;
}

export interface ImportSymbol extends BaseSymbolInfo {
    type: 'import';
    source: string;
    importKind: 'named' | 'namespace' | 'default' | 'side-effect';
    alias?: string;
    imports?: { name: string; alias?: string }[];
    isTypeOnly?: boolean;
}

export interface ExportSymbol extends BaseSymbolInfo {
    type: 'export';
    exportKind: 'named' | 'default' | 'namespace' | 're-export';
    source?: string;
    exports?: { name: string; alias?: string }[];
    isTypeOnly?: boolean;
}

export type SymbolInfo = DefinitionSymbol | ImportSymbol | ExportSymbol;
