
export interface FileSearchResult {
    filePath: string;
    lineNumber: number;
    preview: string;
    score?: number;
    scoreDetails?: ScoreDetails;
    groupedMatches?: Array<{
        lineNumber: number;
        preview: string;
        score?: number;
        scoreDetails?: ScoreDetails;
    }>;
    matchCount?: number;
}

export interface SearchOptions {
    /** Forces whole-word matching when true. Defaults to substring search. */
    wordBoundary?: boolean;
    /** Forces explicit case handling. Defaults to smart-case literals (case-sensitive only when query has uppercase). */
    caseSensitive?: boolean;
    /** When true (default), lowercase-only queries match CamelCase targets (smart-case). */
    smartCase?: boolean;
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
    callGraphBoost?: number;
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

export type NormalizationLevel =
    | "exact"
    | "line-endings"
    | "trailing"
    | "indentation"
    | "whitespace"
    | "structural";

export interface NormalizationConfig {
    /** Number of spaces that represent a tab when normalizing indentation. */
    tabWidth?: number;
    /** Whether to preserve indentation when collapsing whitespace. Defaults to true. */
    preserveIndentation?: boolean;
}

export type ContextFuzziness = "strict" | "normal" | "loose";

export type SafetyLevel = "strict" | "normal" | "force";

export interface MatchConfidence {
    /** Confidence score between 0 (no confidence) and 1 (perfect confidence). */
    score: number;
    /** Strategy that produced the match. */
    matchType: 'exact' | 'normalization' | 'whitespace-fuzzy' | 'levenshtein';
    /** Normalization level that was active when the match was found. */
    normalizationLevel: NormalizationLevel;
    /** Boost applied when before/after context matched. */
    contextBoost: number;
    /** Boost applied when a lineRange constrained the search. */
    lineRangeBoost: number;
    /** Boost applied when indexRange constrained the search. */
    indexRangeBoost?: number;
    /** Textual explanation that can be surfaced to users. */
    reason?: string;
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
    normalization?: NormalizationLevel;
    /** Fine-grained options for normalization attempts (tab width, indentation preservation, etc.) */
    normalizationConfig?: NormalizationConfig;
    /** Optional hash guard for the original content to catch drift before editing. */
    expectedHash?: {
        algorithm: 'sha256' | 'xxhash';
        value: string;
    };
    /** Controls normalization strictness for context matching. Defaults to "normal". */
    contextFuzziness?: ContextFuzziness;
    /** Optional insert semantics for smarter placement-based edits. */
    insertMode?: "before" | "after" | "at";
    /** Line hint for insertMode === "at" (uses start as the target line). */
    insertLineRange?: { start: number };
}

export type DiffMode = "myers" | "semantic";

export interface EditExecutionOptions {
    diffMode?: DiffMode;
}

export type SemanticChangeType = "add" | "remove" | "modify" | "move" | "rename";

export interface SemanticChange {
    type: SemanticChangeType;
    symbolType?: string;
    name: string;
    oldName?: string;
    similarity?: number;
    oldLocation?: LineRange;
    newLocation?: LineRange;
    summary?: string;
}

export interface SemanticDiffSummary {
    changes: SemanticChange[];
    stats: {
        added: number;
        removed: number;
        modified: number;
        renamed: number;
        moved: number;
    };
}

export interface SemanticDiffProvider {
    diff(filePath: string, oldContent: string, newContent: string): Promise<SemanticDiffSummary | undefined>;
}

export interface ToolSuggestion {
    toolName: string;
    rationale: string;
    exampleArgs?: Record<string, unknown>;
    priority?: "high" | "medium" | "low";
}

export interface EnhancedErrorDetails {
    similarSymbols?: string[];
    similarFiles?: string[];
    nextActionHint?: string;
    toolSuggestions?: ToolSuggestion[];
    context?: Record<string, any>;
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
    opportunities?: BatchOpportunity[];
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
    semanticSummary?: SemanticDiffSummary;
    diffModeUsed?: DiffMode;
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

export interface SuggestedBatchEdit {
    operation: "insert" | "replace" | "delete";
    insertMode?: "before" | "after" | "at";
    targetHint?: string;
    replacementTemplate?: string;
}

export interface BatchOpportunity {
    type: "add_import" | "add_trait" | "other";
    description: string;
    affectedFiles: string[];
    supportingFiles?: string[];
    confidence: number;
    suggestedEdit?: SuggestedBatchEdit;
    notes?: string[];
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
    symbolId?: string;
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

export type SkeletonDetailLevel = "minimal" | "standard" | "detailed";

export interface SkeletonOptions {
    /** Include member variables and class attributes when true. Defaults to true. */
    includeMemberVars?: boolean;
    /** Include line/comment blocks when true. Defaults to false. */
    includeComments?: boolean;
    /** Controls folding strictness for method bodies and large regions. */
    detailLevel?: SkeletonDetailLevel;
    /** Maximum literal entries to show when previewing member arrays. Defaults to 3. */
    maxMemberPreview?: number;
}

export interface ReadCodeArgs {
    filePath: string;
    view?: ReadCodeView;
    lineRange?: string;
    skeletonOptions?: SkeletonOptions;
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

export type SearchProjectType = "auto" | "file" | "symbol" | "directory" | "filename";

export interface SearchProjectArgs {
    query: string;
    type?: SearchProjectType;
    maxResults?: number;
    fileTypes?: string[];
    snippetLength?: number;
    matchesPerFile?: number;
    groupByFile?: boolean;
    deduplicateByContent?: boolean;
}

export interface SearchProjectResultEntry {
    type: "file" | "symbol" | "directory" | "filename";
    path: string;
    score: number;
    context?: string;
    line?: number;
    groupedMatches?: FileSearchResult["groupedMatches"];
    matchCount?: number;
}

export interface SearchProjectResult {
    results: SearchProjectResultEntry[];
    inferredType?: "file" | "symbol" | "directory" | "filename";
    message?: string;
    suggestions?: ToolSuggestion[];
    nextActionHint?: string;
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
    normalization?: NormalizationLevel;
    normalizationConfig?: NormalizationConfig;
    expectedHash?: Edit["expectedHash"];
    confirmationHash?: string;
    safetyLevel?: SafetyLevel;
    contextFuzziness?: ContextFuzziness;
    insertMode?: "before" | "after" | "at";
    insertLineRange?: { start: number };
}

export interface RefactoringContext {
    pattern?: "rename-symbol" | "move-function" | "extract-component" | "inline-variable";
    scope?: "file" | "directory" | "project";
    estimatedEdits?: number;
}

export interface EditCodeArgs {
    edits: EditCodeEdit[];
    dryRun?: boolean;
    createMissingDirectories?: boolean;
    ignoreMistakes?: boolean;
    diffMode?: DiffMode;
    refactoringContext?: RefactoringContext;
}

export interface EditCodeResultEntry {
    filePath: string;
    applied: boolean;
    error?: string;
    diff?: string;
    requiresConfirmation?: boolean;
    fileSize?: number;
    lineCount?: number;
    contentPreview?: string;
    hashMismatch?: boolean;
    nextActionHint?: NextActionHint;
}

export interface EditCodeResult {
    success: boolean;
    results: EditCodeResultEntry[];
    transactionId?: string;
    warnings?: string[];
    message?: string;
}

export interface NextActionHint {
    suggestReRead: boolean;
    modifiedContent?: string;
    affectedLineRange?: LineRange;
}

export interface GetBatchGuidanceArgs {
    filePaths: string[];
    pattern?: string;
}


export type ManageProjectCommand = "undo" | "redo" | "guidance" | "status" | "metrics";

export interface ManageProjectArgs {
    command: ManageProjectCommand;
}

export interface ManageProjectResult {
    output: string;
    data?: any;
}
