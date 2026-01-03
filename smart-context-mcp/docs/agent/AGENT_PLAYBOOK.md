# Agent Playbook

> **Five Pillars Architecture** (ADR-040) — Intent-based codebase interaction

---

## The Five Pillars

| Pillar | Intent | Example |
|--------|--------|----------|
| **`explore`** | Find or read | Search, preview, full reads |
| **`understand`** | Comprehend code | Architecture, call graphs, dependencies |
| **`change`** | Modify code | Safe edits with dry-run & impact |
| **`write`** | Create files | Generate, scaffold components |
| **`manage`** | Control state | Undo/redo, status, rebuild |

**Principle:** Express **"What"** (intent) → System handles **"How"** (execution)

---

## Common Patterns

### 1. Analyze → Modify
```typescript
// Step 1: Understand
understand({ goal: "Understand auth logic in UserService" })

// Step 2: Plan (dry-run)
change({ intent: "Add domain whitelist", options: { dryRun: true } })

// Step 3: Verify diff + impact

// Step 4: Apply
change({ intent: "Add domain whitelist" })
```

### 2. Search → Deep Dive
```typescript
// Step 1: Find
explore({ query: "PaymentProcessor" })

// Step 2: Preview results

// Step 3: Full read (if needed)
explore({ paths: ["src/payments/Processor.ts"], view: "full" })
```

---

## Response Structure

Every response includes **`guidance`**:
- `message` — What was achieved
- `suggestedActions` — Next steps (**prioritize these**)
- `warnings` — Risks (God Modules, blast radius)

---

## Layer 3 AI Features

**Optional advanced capabilities** (ADR-042-006, disabled by default):

| Feature | ENV Flag | Description |
|---------|----------|-------------|
| Smart Fuzzy Match | `SMART_CONTEXT_LAYER3_SMART_MATCH=true` | Embedding-based symbol resolution |
| AST Impact | `SMART_CONTEXT_LAYER3_SYMBOL_IMPACT=true` | Auto change impact detection |
| Code Generation | `SMART_CONTEXT_LAYER3_CODE_GEN=true` | Pattern-aware generation |

---

## Legacy Compatibility

**ENV Flags:**
- `SMART_CONTEXT_EXPOSE_LEGACY_TOOLS=true` — Show old tools in list
- `SMART_CONTEXT_LEGACY_AUTOMAP=true` — Auto-map old calls to pillars

**Recommendation:** Use Five Pillars directly for best results.
