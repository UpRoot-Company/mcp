# ADR-035: Adaptive Change Execution (Safe‑by‑Default)

**Status:** Proposed  
**Date:** 2025-12-25  
**Author:** Architecture Team  
**Related ADRs:** ADR-033 (Six Pillars), ADR-034 (Adaptive Resource Budgets), ADR-024/025 (Edit Flexibility)

---

## 1. Executive Summary

`change` requests can be expensive because they trigger heavy impact analysis, multi‑pass matching, and full diff generation—even when the request quality is poor. This ADR introduces **adaptive execution stages**, **budget caps**, and **soft degradation** for `change` so the system remains fast and reliable even under worst‑case agent behavior.

---

## 2. Problem Statement

### 2.1 Observed Issues

- `includeImpact=true` by default triggers heavy operations (dependency graph build, hotspot detection).
- Matching retries (whitespace/structural/levenshtein) can repeat full-file scans.
- Dry-run still performs costly diff generation and impact analysis.
- Target path discovery may invoke full `search_project` scans.

### 2.2 Constraints

- Agents may be naïve or untrusted.
- Hard failures cause retry loops and degrade UX.
- We must preserve correctness and safety (no unsafe edits).

---

## 3. Goals and Non‑Goals

### Goals

- Keep change latency bounded under worst-case requests.
- Minimize heavy analysis unless explicitly needed.
- Avoid retry loops with partial success + guidance.
- Maintain safe edit guarantees.

### Non‑Goals

- Removing impact analysis entirely.
- Guaranteeing full refactor accuracy on low-quality requests.

---

## 4. Decision

Adopt **adaptive change execution** with **progressive refinement**, **budget caps**, and **soft degradation**. Default behavior should be safe and fast, with deep analysis available only on explicit opt‑in.

Core rules:

1. **Safe-by-default**: fast path by default (exact match, single pass).
2. **Progressive refinement**: escalate only when earlier stages fail and budget allows.
3. **Impact on-demand**: heavy analysis only when explicitly requested or required.
4. **Soft degradation**: partial results + actionable guidance, no hard fail.

---

## 5. Design Overview

### 5.1 Staged Execution Pipeline

**Stage 0 (Fast Path):**
- Exact match only, no normalization.
- Diff generation limited to minimal scope.

**Stage 1 (Normalization):**
- Whitespace or structural normalization (budget‑gated).

**Stage 2 (Fuzzy Matching):**
- Levenshtein only for short targets (length cap).

**Stage 3 (Impact/Graph):**
- Impact analyzer, dependency graph, hotspots **only on explicit opt‑in**.

### 5.2 Budget Caps (Change‑Specific)

Per request caps:

- `maxMatchAttempts`
- `maxNormalizationLevels`
- `maxDiffBytes`
- `maxParseTimeMs`
- `maxImpactTimeMs`

If caps are exceeded, the tool returns:

- `status: "partial_success"`
- `degraded: true`
- `guidance` with concrete next steps

### 5.3 Target Resolution Guardrails

- If `targetPath` is missing, use filename/symbol search first.
- Content scanning only if query strength is high and budget allows.
- Prefer explicit targets over fuzzy discovery.

### 5.4 Impact Analysis Policy

Default:
- **dryRun**: skip impact unless explicitly requested.
- **apply**: run impact only if `includeImpact=true`.

When enabled:
- Use cached dependency graph (incremental) whenever possible.
- Avoid repeated analysis in dry-run and apply stages.

### 5.5 Response Metadata

Add response metadata similar to ADR‑034:

```json
{
  "status": "success | partial_success | no_results",
  "degraded": true,
  "budget": {
    "maxMatchAttempts": 2,
    "maxDiffBytes": 200000,
    "used": { "attempts": 2, "parseTimeMs": 1200 }
  },
  "refinement": {
    "stage": "exact|normalized|fuzzy|impact",
    "reason": "budget_exceeded | low_confidence | explicit_opt_in"
  }
}
```

---

## 6. Implementation Plan (High‑Level)

1. Introduce `ChangeBudgetManager` (or reuse BudgetManager with change profile).
2. Add staged matching in `ChangePillar` with budget caps.
3. Guard impact analysis with explicit opt‑in and avoid duplication.
4. Add response metadata for degradation/refinement.
5. Add tests for:
   - Stage escalation limits.
   - Partial success on budget exceed.
   - Impact only when requested.

---

## 7. Alternatives Considered

- **Always run all analyses**  
  Rejected: wastes CPU and increases latency.
- **Hard fail on budget exceed**  
  Rejected: causes retry loops.
- **Disable fuzzy matching**  
  Rejected: reduces edit success on minor mismatches.

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Lower edit success with strict budgets | Progressive refinement + opt‑in deep mode |
| Agents ignore guidance | Auto‑fallbacks in same request |
| Confusion about partial results | Explicit `degraded` + clear guidance |

---

## 9. Success Metrics

- P95 latency for `change` reduced by 40%+ on large repos.
- Retry loops drop by 60%+.
- Impact analysis invoked only when explicitly requested.

---

## 10. Decision Outcome

Adopt adaptive, staged execution for `change` to ensure fast, safe edits under worst‑case requests while preserving the ability to run deep analysis when needed.
