
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

export type SearchFieldType = "symbol-definition" | "signature" | "exported-member" | "comment" | "code-body";

export interface ScoreDetails {
    contentScore: number;
    filenameMultiplier: number;
    depthMultiplier: number;
    fieldWeight: number;
    totalScore: number;
    filenameMatchType: "exact" | "partial" | "none";
    fieldType?: SearchFieldType;
}

export type CallType = "direct" | "method" | "constructor" | "callback" | "optional" | "unknown";

export interface CallSiteInfo {
    calleeName: string;
    calleeObject?: string;
    callType: CallType;
    line: number;
    column: number;
    text?: string;
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

export type ImpactRiskLevel = 'low' | 'medium' | 'high';

export interface ImpactPreview {
    filePath: string;
    riskLevel: ImpactRiskLevel;
    summary: {
        incomingCount: number;
        outgoingCount: number;
        impactedFiles: string[];
    };
    editCount: number;
    suggestedTests?: string[];
    notes?: string[];
}

export interface BatchEditGuidance {
    clusters: Array<{ files: string[]; reason: string }>;
    companionSuggestions: Array<{ filePath: string; reason: string }>;
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
    warnings?: string[];
    impactPreview?: ImpactPreview;
    impactPreviews?: ImpactPreview[];
    batchGuidance?: BatchEditGuidance;
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
    fieldType?: SearchFieldType;
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
    type: 'class' | 'function' | 'method' | 'interface' | 'variable' | 'export_specifier' | 'type_alias';
    signature?: string;
    parameters?: string[];
    returnType?: string;
    calls?: CallSiteInfo[];
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

export type CallConfidence = "definite" | "possible" | "inferred";

export interface CallGraphEdge {
    fromSymbolId: string;
    toSymbolId: string;
    callType: CallType;
    confidence: CallConfidence;
    line: number;
    column: number;
}

export interface CallGraphNode {
    symbolId: string;
    symbolName: string;
    filePath: string;
    symbolType: DefinitionSymbol['type'];
    range: DefinitionSymbol['range'];
    callers: CallGraphEdge[];
    callees: CallGraphEdge[];
}

export interface CallGraphResult {
    root: CallGraphNode;
    visitedNodes: Record<string, CallGraphNode>;
    truncated: boolean;
}

export type TypeRelationKind = 'extends' | 'implements' | 'alias' | 'constraint' | 'usage';

export interface TypeRelationInfo {
    targetName: string;
    relationKind: TypeRelationKind;
    confidence: CallConfidence;
}

export interface TypeGraphEdge {
    fromSymbolId: string;
    toSymbolId: string;
    relationKind: TypeRelationKind;
    confidence: CallConfidence;
}

export interface TypeGraphNode {
    symbolId: string;
    symbolName: string;
    filePath: string;
    symbolType: DefinitionSymbol['type'];
    range: DefinitionSymbol['range'];
    parents: TypeGraphEdge[];
    dependencies: TypeGraphEdge[];
}

export interface TypeGraphResult {
    root: TypeGraphNode;
    visitedNodes: Record<string, TypeGraphNode>;
    truncated: boolean;
}

export type DataFlowStepType = 'definition' | 'parameter' | 'assignment' | 'mutation' | 'usage' | 'call_argument' | 'return';

export type DataFlowRelation = 'next';

export interface DataFlowStep {
    id: string;
    stepType: DataFlowStepType;
    filePath: string;
    range: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    };
    textSnippet: string;
    symbolName?: string;
    metadata?: Record<string, unknown>;
}

export interface DataFlowEdge {
    fromStepId: string;
    toStepId: string;
    relation: DataFlowRelation;
}

export interface DataFlowResult {
    sourceStepId: string;
    steps: Record<string, DataFlowStep>;
    orderedStepIds: string[];
    edges: DataFlowEdge[];
    truncated: boolean;
}

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

export type ReadCodeView = "full" | "skeleton" | "fragment";

export interface ReadCodeArgs {
    filePath: string;
    view?: ReadCodeView;
    lineRange?: string;
}

export interface ReadCodeResult {
    content: string;
    metadata: {
        lines: number;
        language: string | null;
        path: string;
    };
    truncated: boolean;
}

export type SearchProjectType = "auto" | "file" | "symbol" | "directory";

export interface SearchProjectArgs {
    query: string;
    type?: SearchProjectType;
    maxResults?: number;
}

export interface SearchProjectResultEntry {
    type: "file" | "symbol" | "directory";
    path: string;
    score: number;
    context?: string;
    line?: number;
}

export interface SearchProjectResult {
    results: SearchProjectResultEntry[];
    inferredType?: "file" | "symbol" | "directory";
}

export type AnalyzeRelationshipMode = "impact" | "dependencies" | "calls" | "data_flow" | "types";

export type AnalyzeRelationshipDirection = "upstream" | "downstream" | "both";

export interface AnalyzeRelationshipArgs {
    target: string;
    targetType?: "auto" | "file" | "symbol";
    contextPath?: string;
    mode: AnalyzeRelationshipMode;
    direction?: AnalyzeRelationshipDirection;
    maxDepth?: number;
    fromLine?: number;
}

export interface AnalyzeRelationshipNode {
    id: string;
    type: string;
    path?: string;
    label?: string;
}

export interface AnalyzeRelationshipEdge {
    source: string;
    target: string;
    relation: string;
}

export interface ResolvedRelationshipTarget {
    type: "file" | "symbol" | "variable";
    path: string;
    symbolName?: string;
}

export interface AnalyzeRelationshipResult {
    nodes: AnalyzeRelationshipNode[];
    edges: AnalyzeRelationshipEdge[];
    resolvedTarget: ResolvedRelationshipTarget;
}

export interface EditCodeEdit {
    filePath: string;
    operation: "replace" | "create" | "delete";
    targetString?: string;
    replacementString?: string;
    lineRange?: LineRange;
    beforeContext?: string;
    afterContext?: string;
    fuzzyMode?: "whitespace" | "levenshtein";
    anchorSearchRange?: { lines: number; chars: number };
    indexRange?: IndexRange;
    normalization?: "exact" | "whitespace" | "structural";
    expectedHash?: Edit["expectedHash"];
}

export interface EditCodeArgs {
    edits: EditCodeEdit[];
    dryRun?: boolean;
    createMissingDirectories?: boolean;
    ignoreMistakes?: boolean;
}

export interface EditCodeResultEntry {
    filePath: string;
    applied: boolean;
    error?: string;
    diff?: string;
}

export interface EditCodeResult {
    success: boolean;
    results: EditCodeResultEntry[];
    transactionId?: string;
}

export type ManageProjectCommand = "undo" | "redo" | "guidance" | "status";

export interface ManageProjectArgs {
    command: ManageProjectCommand;
}

export interface ManageProjectResult {
    output: string;
    data?: any;
}
