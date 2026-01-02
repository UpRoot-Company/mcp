# Tool Permission Configuration Guide

This guide shows safe permission patterns for using Smart Context MCP with agents/IDEs.

Smart Context’s default MCP tool surface is the **Five Pillars**:
`explore`, `understand`, `change`, `write`, `manage`.

---

## Recommended patterns

### 1) Read-only (safest)

Use when you want analysis/documentation with no edits.

```json
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(pwd:*)",
      "Bash(cat:*)",
      "mcp__smart-context-mcp__explore",
      "mcp__smart-context-mcp__understand"
    ],
    "deny": [
      "Bash(rm:*)",
      "Bash(mv:*)",
      "Bash(curl:*)",
      "Bash(wget:*)"
    ]
  }
}
```

### 2) Safe development (recommended)

Use for day-to-day coding with tests.

```json
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Bash(pwd:*)",
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(pnpm:*)",
      "Bash(yarn:*)",
      "mcp__smart-context-mcp__*"
    ],
    "deny": [
      "Bash(rm:*)",
      "Bash(mv:*)",
      "Bash(curl:*)",
      "Bash(wget:*)"
    ]
  }
}
```

### 3) Locked-down CI

Allow analysis plus running tests/build, but keep edits disabled.

```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm test:*)",
      "Bash(npm run build:*)",
      "mcp__smart-context-mcp__explore",
      "mcp__smart-context-mcp__understand"
    ],
    "deny": [
      "mcp__smart-context-mcp__change",
      "mcp__smart-context-mcp__write",
      "Bash(rm:*)",
      "Bash(mv:*)"
    ]
  }
}
```

---

## Legacy tools (opt-in)

If you enable legacy tool names (e.g. `search_project`, `read_code`, `edit_code`) via environment variables, you must also allow them explicitly in your tool permissions.

See:
- `smart-context-mcp/docs/compat/README.md`
- `smart-context-mcp/docs/compat/LEGACY_TOOL_CATALOG.md`

