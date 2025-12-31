# Agent Playbook: Smart Context - Six Pillars

This guide defines how to use the **Six Pillars Architecture** to interact with the codebase efficiently.

## Core Mandate: "What vs How"
You express **"What"** you want to achieve using the 6 high-level pillars. The system automatically determines **"How"** to execute it using internal tools.

---

## 1. The Six Pillars (Quick Reference)

| Pillar | Intent | Use Case |
|:---|:---|:---|
| **`understand`** | "I want to comprehend this code." | Analyze logic, architecture, call graphs, and dependencies. |
| **`change`** | "I want to modify this code." | Safely edit code with auto-DryRun and impact analysis. |
| **`navigate`** | "I want to find something." | Locate symbols, files, or definitions across the project. |
| **`read`** | "I want to see the content." | Efficiently read files using skeletons or specific fragments. |
| **`write`** | "I want to create something." | Generate new files or scaffold project components. |
| **`manage`** | "I want to control state." | Undo/redo changes, check status, or rebuild indices. |

---

## 2. Standard Workflows

### Pattern A: Analyze → Modify
1.  **Understand**: `understand({ goal: "Understand auth logic in UserService" })`
2.  **Review**: Check the `structure` and `guidance` from the response.
3.  **Plan Change**: `change({ intent: "Add domain whitelist", options: { dryRun: true } })`
4.  **Verify**: Review the `diff` and `impactReport`.
5.  **Apply**: `change({ intent: "Add domain whitelist", options: { dryRun: false } })`

### Pattern B: Search → Deep Dive
1.  **Navigate**: `navigate({ target: "PaymentProcessor" })`
2.  **Examine**: Use the `smartProfile` provided in the response.
3.  **Read**: `read({ target: "src/payments/Processor.ts", view: "fragment" })`

---

## 3. Intelligent Guidance
Every response includes a `guidance` field.
- **`message`**: A summary of what was achieved.
- **`suggestedActions`**: The best next steps. **Always prioritize these.**
- **`warnings`**: Risks like God Modules or high blast radius.

---

## 4. Legacy Compatibility
Legacy tools are hidden by default in the MCP tool list. If you need them for compatibility, enable:

- `SMART_CONTEXT_EXPOSE_LEGACY_TOOLS=true` (expose legacy tools in tool list)
- `SMART_CONTEXT_LEGACY_AUTOMAP=true` (auto-map unknown legacy calls to pillars)

Even with legacy tools enabled, using the 6 pillars directly is recommended for optimal performance and consistent guidance.
