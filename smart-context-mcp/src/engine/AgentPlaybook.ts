export interface WorkflowStep {
    name: string;
    description: string;
    tools?: string[];
    hint?: string;
    best_practice?: string;
    tool_args?: Record<string, unknown>;
}

export interface RecoveryStrategy {
    code: string;
    meaning: string;
    action: {
        toolName: string;
        exampleArgs?: Record<string, unknown>;
        rationale: string;
    };
}

export const AgentWorkflowGuidance: {
    workflow: {
        title: string;
        description: string;
        steps: WorkflowStep[];
    };
    recovery: RecoveryStrategy[];
    metadata: { version: string };
} = {
    workflow: {
        title: "Standard Agent Workflow for Code Modification",
        description: "Follow these stages to scout, understand, edit, and validate changes safely in smart-context-mcp.",
        steps: [
            {
                name: "Scout & Discover",
                description: "Identify relevant files, directories, and symbols before reading large blobs.",
                tools: ["search_files", "list_directory"],
                hint: "Narrow results using keywords, glob filters, or depth limits instead of opening entire directories."
            },
            {
                name: "Profile & Understand",
                description: "Load a Smart File Profile to review metadata, relationships, and skeletons without the full file.",
                tools: ["read_file"],
                tool_args: { full: false },
                hint: "Pay attention to newline/indent style, config scope, and dependency counts before editing."
            },
            {
                name: "Fragment & Detail",
                description: "Zoom in on precise sections for planning the change.",
                tools: ["read_fragment"],
                hint: "Use skeleton line numbers to craft `lineRange` + `contextLines` and keep payloads small."
            },
            {
                name: "Plan Edits",
                description: "Design the exact multi-line change including anchors, hashes, and normalization level.",
                hint: "Prefer `lineRange` + `expectedHash`; set `normalization` to `whitespace`/`structural` when formatting is inconsistent."
            },
            {
                name: "Edit & Modify",
                description: "Apply atomic edits and ensure they can be undone.",
                tools: ["edit_file", "batch_edit"],
                best_practice: "Scope each edit, use normalization or fuzzy modes sparingly, and rely on stored inverse edits for recovery."
            },
            {
                name: "Validate & Verify",
                description: "Re-profile or fragment the touched files and run relevant tests before finishing.",
                tools: ["read_file", "read_fragment", "run_shell_command"],
                hint: "Confirm Smart File Profile metadata (hashes, dependencies) settled before handing off."
            }
        ]
    },
    recovery: [
        {
            code: "NO_MATCH",
            meaning: "The editor could not find the target text block.",
            action: {
                toolName: "debug_edit_match",
                exampleArgs: { normalization: "whitespace" },
                rationale: "Inspect candidate regions and switch normalization or anchors before retrying."
            }
        },
        {
            code: "AMBIGUOUS_MATCH",
            meaning: "Multiple blocks matched the same target.",
            action: {
                toolName: "debug_edit_match",
                exampleArgs: { lineRange: { start: 10, end: 20 } },
                rationale: "Review conflicting lines, then retry edit_file with a tighter lineRange or context."
            }
        },
        {
            code: "HASH_MISMATCH",
            meaning: "File drift detected between planning and editing.",
            action: {
                toolName: "read_file",
                exampleArgs: { full: false },
                rationale: "Refresh the Smart File Profile to recalculate hashes before constructing a new edit."
            }
        },
        {
            code: "PARSE_ERROR",
            meaning: "AST parsing failed for the requested language or file.",
            action: {
                toolName: "read_file",
                exampleArgs: { full: true },
                rationale: "Inspect the raw file (or fix syntax) before re-running AST-dependent tools."
            }
        },
        {
            code: "INDEX_STALE",
            meaning: "Dependency/index information is outdated.",
            action: {
                toolName: "rebuild_index",
                rationale: "Refresh dependency graph caches before relying on usage data."
            }
        }
    ],
    metadata: {
        version: "2025-12-09"
    }
};
