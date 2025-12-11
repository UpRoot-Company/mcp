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
                tools: ["search_project"],
                hint: "Use inferred type switching (auto/file/symbol/directory) to jump directly to the needed targets."
            },
            {
                name: "Profile & Understand",
                description: "Load Smart File Profile metadata and skeletons without fetching the entire file.",
                tools: ["read_code"],
                tool_args: { view: "skeleton" },
                hint: "Capture newline style, indent, and dependency counts before planning edits."
            },
            {
                name: "Fragment & Detail",
                description: "Zoom in on precise sections for planning the change.",
                tools: ["read_code"],
                tool_args: { view: "fragment" },
                hint: "Combine skeleton line numbers with explicit `lineRange` to keep payloads small and targeted."
            },
            {
                name: "Plan Edits",
                description: "Design the exact multi-line change including anchors, hashes, and normalization level.",
                hint: "Prefer `lineRange` + `expectedHash`; set `normalization` to `whitespace`/`structural` when formatting is inconsistent."
            },
            {
                name: "Impact Analysis",
                description: "Preview how far the planned change propagates before mutating files.",
                tools: ["analyze_relationship"],
                hint: 'Use `mode="impact"` for files and `mode="calls"`/`"data_flow"` for symbols before `edit_code` to avoid surprises.',
                best_practice: "Pause when relationship graphs fan out unexpectedly; split work or add guardrails before editing."
            },
            {
                name: "Edit & Modify",
                description: "Apply atomic edits and ensure they can be undone.",
                tools: ["edit_code"],
                best_practice: "Batch related operations into one transaction, leverage `dryRun` for validation, and capture transaction IDs for audits."
            },
            {
                name: "Validate & Verify",
                description: "Re-profile or fragment the touched files and run relevant tests before finishing.",
                tools: ["read_code", "manage_project"],
                hint: 'Re-run `read_code(view="skeleton")` on edited files and call `manage_project` (`status`, `undo`, or `redo`) as needed before handoff.'
            }
        ]
    },
    recovery: [
        {
            code: "NO_MATCH",
            meaning: "The editor could not find the target text block.",
            action: {
                toolName: "read_code",
                exampleArgs: { view: "fragment", lineRange: "120-140" },
                rationale: "Inspect the exact lines you plan to replace, then refine `lineRange`, anchors, or `ignoreMistakes` before resubmitting `edit_code`."
            }
        },
        {
            code: "AMBIGUOUS_MATCH",
            meaning: "Multiple blocks matched the same target.",
            action: {
                toolName: "read_code",
                exampleArgs: { view: "skeleton" },
                rationale: "Compare the skeleton to disambiguate symbols and narrow `edit_code` targets with tighter context."
            }
        },
        {
            code: "HASH_MISMATCH",
            meaning: "File drift detected between planning and editing.",
            action: {
                toolName: "read_code",
                exampleArgs: { view: "full" },
                rationale: "Refresh Smart File Profile metadata to capture the latest hash before constructing a new edit request."
            }
        },
        {
            code: "PARSE_ERROR",
            meaning: "AST parsing failed for the requested language or file.",
            action: {
                toolName: "read_code",
                exampleArgs: { view: "full" },
                rationale: "Inspect the raw file (or fix syntax) before re-running `analyze_relationship` in symbol/flow modes."
            }
        },
        {
            code: "INDEX_STALE",
            meaning: "Dependency/index information is outdated.",
            action: {
                toolName: "manage_project",
                exampleArgs: { command: "status" },
                rationale: "Check index health, wait for background rebuilds, and only then trust `analyze_relationship` outputs."
            }
        }
    ],
    metadata: {
        version: "2025-12-10"
    }
};
