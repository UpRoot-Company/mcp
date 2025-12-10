
export interface FileSearchResult {
    filePath: string;
    lineNumber: number;
    preview: string;
    score?: number;
    scoreDetails?: ScoreDetails;
}

export interface SearchOptions {
    /** Forces whole-word matching when true. Defaults to substring search. */
    wordBoundary?: boolean;
}

export interface ScoreDetails {
    contentScore: number;
    filenameMultiplier: number;
    depthMultiplier: number;
    totalScore: number;
    filenameMatchType: "exact" | "partial" | "none";
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
    /** Highest normalization tier the editor should consider. Defaults to "exact". */
    normalization?: "exact" | "whitespace" | "structural";
    /** Optional hash guard for the original content to catch drift before editing. */
    expectedHash?: {
        algorithm: 'sha256' | 'xxhash';
        value: string;
    };
}

export interface ToolSuggestion {
    toolName: string;
    rationale: string;
    exampleArgs?: Record<string, unknown>;
}

export interface MatchDiagnostics {
    attempts: {
        mode: string;
        candidates: { line: number; snippet: string; score?: number }[];
        failureReason: string;
    }[];
}

export interface EditResult {
    success: boolean;
    message?: string;
    diff?: string;
    structuredDiff?: { filePath: string; diff: string; added: number; removed: number }[];
    originalContent?: string;
    newContent?: string;
    details?: ErrorDetails;
    suggestion?: ToolSuggestion;
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
    filePath?: string;
    scoreDetails?: ScoreDetails;
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

export interface Point {
    row: number;
    column: number;
}

export interface BaseSymbolInfo {
    name: string;
    start?: Point;
    end?: Point;
    range: { startLine: number; endLine: number; startByte: number; endByte: number };
    container?: string;
    modifiers?: string[];
    doc?: string;
    content?: string;
}

export interface DefinitionSymbol extends BaseSymbolInfo {
    type: 'class' | 'function' | 'method' | 'interface' | 'variable' | 'export_specifier';
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

export interface SmartFileProfile {
    metadata: {
        filePath: string;
        relativePath: string;
        sizeBytes: number;
        lineCount: number;
        language: string | null;
        lastModified?: string; // ISO date string
        newlineStyle?: "lf" | "crlf" | "mixed";
        encoding?: string; // e.g., "utf-8"
        hasBOM?: boolean;
        usesTabs?: boolean;
        indentSize?: number | null;
        isConfigFile?: boolean;
        configType?: 'tsconfig' | 'package.json' | 'lintrc' | 'editorconfig' | 'other';
        configScope?: 'project' | 'directory' | 'file';
    };
    structure: {
        skeleton: string;
        symbols: SymbolInfo[];
        complexity?: {
            functionCount: number;
            linesOfCode: number;
            maxNestingDepth?: number;
        };
    };
    usage: {
        incomingCount: number;
        incomingFiles: string[];
        outgoingCount?: number;
        outgoingFiles?: string[];
        testFiles?: string[];
    };
    guidance: {
        bodyHidden: boolean;
        readFullHint: string;
        readFragmentHint: string;
    };
}

export interface IndexStatus {
    global: {
        totalFiles: number;
        indexedFiles: number;
        unresolvedImports: number;
        resolutionErrors: Array<{ filePath: string; importSpecifier: string; error: string; }>;
        lastRebuiltAt: string; // ISO date string
        confidence: 'high' | 'medium' | 'low';
        isMonorepo: boolean;
    };
    perFile?: Record<string, {
        resolved: boolean;
        unresolvedImports: string[];
        incomingDependenciesCount: number;
        outgoingDependenciesCount: number;
    }>;
}

export interface EngineConfig {
    mode?: "prod" | "ci" | "test";
    parserBackend?: "wasm" | "js" | "snapshot" | "auto";
    snapshotDir?: string;
    rootPath?: string;
}
