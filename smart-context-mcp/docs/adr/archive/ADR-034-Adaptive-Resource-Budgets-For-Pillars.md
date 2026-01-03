# ADR-034: Adaptive Resource Budgets for Navigate/Understand

**Status:** Proposed  
**Date:** 2025-12-25  
**Author:** Architecture Team  
**Related ADRs:** ADR-033 (Six Pillars), ADR-028 (Performance), ADR-030 (Agent-Centric Intelligence)

---

## 1. Executive Summary

Large projects can trigger high CPU usage when `navigate`/`understand` receive worst-case requests. This ADR introduces **adaptive resource budgets**, **progressive refinement**, and **soft degradation** so the server remains responsive even when agents misuse tools. The system will *avoid hard failures* and instead return partial results with clear, actionable guidance.

---

## 2. Problem Statement

### 2.1 Observed Issues

- `search_project` defaults to content-scanning paths that read many files and compute BM25/Hybrid scores.
- Symbol and dependency analyses can trigger full-project scans and graph rebuilds.
- `understand` executes multiple heavy tools in parallel, amplifying CPU spikes.

### 2.2 Constraints

- Agents may be untrusted or naive; we cannot assume correct tool usage.
- We should preserve agent experience and avoid “retry loops.”
- Results must remain useful even when heavy work is skipped.

---

## 3. Goals and Non‑Goals

### Goals

- Keep CPU usage bounded under worst-case requests.
- Reduce full-project scans unless explicitly necessary.
- Provide useful partial results without requiring agent retries.
- Allow opt‑in deep analysis when explicitly requested.

### Non‑Goals

- Perfect global accuracy for worst-case requests.
- Eliminating all heavy operations (only controlling when/how they occur).

---

## 4. Decision

Adopt **adaptive resource budgets** and **progressive refinement** for `navigate` and `understand`, with soft degradation rather than hard failures.

Core rules:

1. **Safe-by-default**: prefer cheap paths unless explicit intent requires heavy work.
2. **Budgeted execution**: enforce caps on candidates/files/bytes/parse time.
3. **Progressive refinement**: escalate only if early stages are insufficient.
4. **Soft degrade**: return partial results + guidance instead of errors.
5. **Agent-loop prevention**: include actionable, concrete next steps in responses.

---

## 5. Design Overview

### 5.1 Resource Budget Manager

Introduce a shared component that computes budgets based on:

- Project size (file count, index size, total LOC).
- Query quality (length, entropy, symbol likelihood).
- Caller intent (navigate vs understand, include flags).
- Current system load (optional future extension).

**Budget inputs (examples):**

- `maxCandidates`
- `maxFilesRead`
- `maxBytesRead`
- `maxParseTimeMs`
- `maxGraphNodes`

### 5.2 Progressive Refinement Pipeline

**Stage 0 (Always):** filename + symbol search  
**Stage 1 (Conditional):** limited content scan within budget  
**Stage 2 (Opt‑in):** dependencies/call graph/hotspots

Escalation rule:

- If Stage 0 results are *high confidence* → stop early.
- If Stage 0 results are *weak* and budget allows → run Stage 1.
- Stage 2 runs only when explicitly requested (`include.* = true`) and within budget.

### 5.3 Soft Degradation Strategy

When budgets are exceeded:

- Return **partial results** with `status: "partial_success"` and `degraded: true`.
- Provide *ready-to-use* next steps (e.g., recommend `basePath`, `type: filename`).
- Avoid multi-turn retry loops by **automatically** applying safe fallbacks.

### 5.4 Navigate Pillar Changes

Current:
- Always uses `search_project` (content search by default).
- May trigger expensive analyses (pageRank, hotspot, references).

Proposed:

- Default to `type: filename` or `type: symbol` unless query is strong.
- Only compute pageRank/hotspots if explicitly requested and within budget.
- If context mode is `usages`, only call `reference_finder` when a symbol match is found.
- Add a lightweight confidence score to decide whether to escalate.

### 5.5 Understand Pillar Changes

Current:
- Parallel calls to `read_code`, `file_profiler`, `analyze_relationship`, `hotspot_detector`.

Proposed:

- Always compute skeleton/profile (cheap, cached).
- Calls/deps/hotspots only if `include.*` is true **and** budget permits.
- If budget blocks heavy ops, return partial result with guidance:
  - “Dependencies skipped due to budget; request include.dependencies with basePath for deep analysis.”

---

## 6. API/Response Additions

Add optional metadata to responses:

```json
{
  "status": "success | partial_success | no_results",
  "degraded": true,
  "budget": {
    "maxCandidates": 500,
    "maxFilesRead": 200,
    "maxBytesRead": 2000000,
    "maxParseTimeMs": 1500,
    "used": { "filesRead": 120, "bytesRead": 1800000, "parseTimeMs": 1300 }
  },
  "refinement": {
    "stage": "filename|symbol|content|graph",
    "reason": "budget_exceeded | low_confidence | explicit_opt_in"
  },
  "guidance": {
    "message": "Partial results. To deepen, provide basePath or specify type: filename.",
    "suggestedActions": [ ... ]
  }
}
```

These fields allow agents to adjust behavior without guesswork and reduce retry loops.

---

## 7. Configuration Knobs (Defaults)

Provide tunables via config/env:

- `SMART_CONTEXT_MAX_CANDIDATES` (default: adaptive)
- `SMART_CONTEXT_MAX_FILES_READ`
- `SMART_CONTEXT_MAX_BYTES_READ`
- `SMART_CONTEXT_MAX_PARSE_MS`
- `SMART_CONTEXT_SAFE_MODE` (`true` by default)
- `SMART_CONTEXT_BUDGET_PROFILE` (`safe | balanced | deep`, default: `safe`)

Adaptive defaults adjust based on project size.

---

## 8. Implementation Plan (Detailed)

### 8.1 New Components

- **BudgetManager** (new module)
  - Path: `src/orchestration/BudgetManager.ts`
  - Responsibilities:
    - Derive budgets per request (navigate/understand) using project size + query quality.
    - Track usage (files read, bytes, parse time) and expose `shouldDegrade()` helpers.
  - Inputs:
    - `intent`, `constraints`, `projectStats`, `queryMetrics`
  - Outputs:
    - `budget` (limits) + `usage` (current counters) + `profile` (`safe|balanced|deep`)

- **QueryMetrics** (lightweight helper)
  - Path: `src/engine/search/QueryMetrics.ts`
  - Responsibilities:
    - Compute query length, token count, entropy proxy, symbol-likeness.
    - Provide `isStrongQuery()` for escalation gating.

### 8.2 search_project (core execution path)

- File: `src/index.ts`
  - Function: `searchProjectRaw(args)`
  - Changes:
    - Accept `budget` optional arg (internal use).
    - Enforce `maxCandidates/maxFilesRead/maxBytesRead` in `SearchEngine.scout`.
    - If budget exceeded, **degrade** to `type=filename` or `type=symbol` results.
    - Return `degraded` + `budget` usage metadata.

- File: `src/engine/Search.ts`
  - Function: `scout(args)`
  - Changes:
    - Stop reading candidate chunks when `budget.maxFilesRead` or `maxBytesRead` is reached.
    - Track `usage.filesRead`, `usage.bytesRead` and return partial results with `degraded=true`.
    - Add a cheap early‑exit when `candidates.size` exceeds cap (switch to filename/symbol).

### 8.3 Navigate Pillar (progressive refinement)

- File: `src/orchestration/pillars/NavigatePillar.ts`
  - Changes:
    - Instantiate `BudgetManager` and `QueryMetrics` (via orchestration context).
    - Stage 0: run `search_project` with `type=filename` or `type=symbol` if weak query.
    - Stage 1: run content search only if `queryMetrics.isStrongQuery()` and budget allows.
    - Stage 2: run `reference_finder`/`pageRank`/`hotspot_detector` only when requested and within budget.
    - Populate `degraded`, `budget`, `refinement` fields on response.

### 8.4 Understand Pillar (budget‑aware parallelism)

- File: `src/orchestration/pillars/UnderstandPillar.ts`
  - Changes:
    - Use `BudgetManager` to decide whether to run `analyze_relationship` and `hotspot_detector`.
    - Convert `Promise.all` to a staged plan:
      - Always run `read_code` + `file_profiler`.
      - Only run `calls/deps/hotspots` when `include.*` and budget permits.
    - Return `partial_success` with guidance if heavy steps are skipped.

### 8.5 Response Metadata

- File: `src/orchestration/OrchestrationEngine.ts`
  - Merge `budget` + `degraded` + `refinement` from pillars into final response.
  - Ensure guidance includes concrete safe re‑invocation examples.

### 8.6 Config + Defaults

- File: `src/config/ConfigurationManager.ts` (or new config module)
  - Add env‑backed defaults:
    - `SMART_CONTEXT_MAX_CANDIDATES`
    - `SMART_CONTEXT_MAX_FILES_READ`
    - `SMART_CONTEXT_MAX_BYTES_READ`
    - `SMART_CONTEXT_MAX_PARSE_MS`
    - `SMART_CONTEXT_BUDGET_PROFILE`

### 8.7 Tests

- Unit tests
  - `src/tests/orchestration/NavigateBudget.test.ts`
  - `src/tests/orchestration/UnderstandBudget.test.ts`
  - Validate: budget thresholds trigger degrade + partial response.
- Integration tests
  - `src/tests/search_budget.integration.test.ts`
  - Ensure `search_project` returns partial results without errors under tight budgets.

### 8.8 Rollout Plan

- Phase 1: introduce BudgetManager + metadata fields (no behavior change).
- Phase 2: enforce caps in `SearchEngine.scout` (safe degrade).
- Phase 3: staged execution in `navigate/understand`.
- Phase 4: tighten defaults + expose config knobs.

---

## 9. Alternatives Considered

- **Hard fail on budget exceed**  
  Rejected: causes agent retry loops and poor UX.
- **Always allow deep analysis**  
  Rejected: CPU spikes and poor worst-case behavior.
- **Disable heavy tools entirely**  
  Rejected: reduces system capability and value.

---

## 10. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Partial results reduce accuracy | Provide clarity + allow opt-in deep analysis |
| Agents ignore guidance | Automatic safe fallback within same request |
| Budget too strict for some repos | Adaptive budgets + configurable profiles |

---

## 11. Success Metrics

- P95 CPU usage for `navigate`/`understand` drops by 50%+ on large repos.
- % of requests completing without a retry loop increases (target > 90%).
- Median latency in large repos decreases by 30%+.

---

## 12. Decision Outcome

Adopt adaptive budgets + progressive refinement + soft degradation to ensure the system remains performant and user-friendly under worst-case agent behavior, while preserving access to deep analysis when explicitly requested.
