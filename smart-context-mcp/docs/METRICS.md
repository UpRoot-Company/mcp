# Metrics Reference

This document describes the metrics collected by smart-context-mcp, including the new v2 editor metrics introduced by ADR-042-005.

## Editor v2 Metrics (ADR-042-005)

The "Resolve → Apply" separation introduces granular timing metrics for edit operations:

### `change.resolve_ms`

**Type:** Timer (milliseconds)  
**Scope:** Per-file edit resolution  
**Emitted:** `ChangePillar.executeV2BatchChange()`  

Measures time spent resolving edit targets to specific byte ranges:
- String matching with `findAllMatches()`
- Levenshtein fuzzy matching (when allowed)
- Ambiguous match detection
- Cost guardrail checks

**Performance Targets:**
- p50: < 100ms
- p95: < 300ms
- p99: < 500ms (before timeout at 1500ms)

**Usage:**
```typescript
const stopResolve = metrics.startTimer("change.resolve_ms");
const resolved = await resolver.resolveAll(fileEdits, options);
stopResolve();
```

---

### `change.apply_ms`

**Type:** Timer (milliseconds)  
**Scope:** Per-file edit application  
**Emitted:** `ChangePillar.executeV2BatchChange()`  

Measures time spent applying resolved edits via `EditCoordinator`:
- Converting `ResolvedEdit[]` to `Edit[]` format
- Calling `applyBatchResolvedEdits()` or `applyResolvedEdits()`
- FileSystem write operations (when not dry-run)

**Performance Targets:**
- p50: < 50ms
- p95: < 150ms
- p99: < 300ms

**Usage:**
```typescript
const stopApply = metrics.startTimer("change.apply_ms");
await coordinator.applyBatchResolvedEdits(filePath, resolved);
stopApply();
```

---

### `write.safe_patch_ms`

**Type:** Timer (milliseconds)  
**Scope:** Per-file safe write operation  
**Emitted:** `WritePillar.executeV2BatchChange()` (safeWrite mode)  

Measures time for safe write path:
- Full file range resolution via `EditResolver`
- Range-based patch application via `EditCoordinator`
- Operation record creation for undo/redo
- Content hash verification

**Performance Targets:**
- p50: < 100ms
- p95: < 250ms
- p99: < 500ms

**Usage:**
```typescript
const stopSafePatch = metrics.startTimer("write.safe_patch_ms");
await coordinator.applyResolvedEdits(filePath, resolvedEdits);
opRegistry.recordOperation(/* ... */);
stopSafePatch();
```

---

## Cost Guardrails Impact

These metrics help monitor the effectiveness of cost guardrails:

| Guardrail | Metric Impact | Threshold |
|-----------|---------------|-----------|
| `RESOLVE_TIMEOUT_MS` | Max value for `change.resolve_ms` | 1500ms (default) |
| `MIN_LEVENSHTEIN_TARGET_LEN` | Reduced `change.resolve_ms` variance | 20 chars (default) |
| `MAX_LEVENSHTEIN_FILE_BYTES` | Prevents tail latency spikes | 100KB (default) |

**Example:** If `change.resolve_ms` p99 exceeds 1000ms, review timeout configuration or target match complexity.

---

## ENV Configuration

Enable v2 metrics collection:

```bash
# Required: Enable v2 code path
SMART_CONTEXT_EDITOR_V2=true

# Optional: Control execution mode
V2_MODE=dryrun   # Collect resolve_ms only (no apply_ms)
V2_MODE=apply    # Collect both resolve_ms and apply_ms

# Optional: Tune cost guardrails
RESOLVE_TIMEOUT_MS=1500
MIN_LEVENSHTEIN_TARGET_LEN=20
MAX_LEVENSHTEIN_FILE_BYTES=100000
```

---

## Monitoring Recommendations

### Dashboard Queries

**Resolve vs. Apply Ratio:**
```
change.resolve_ms / (change.resolve_ms + change.apply_ms)
```
- Expected: ~30-40% (resolve should be faster than apply)
- Alert if > 50% (resolve bottleneck)

**Safe Write Overhead:**
```
write.safe_patch_ms - write.fast_write_ms
```
- Expected: < 50ms overhead for undo/redo support
- Alert if > 100ms (patch efficiency issue)

**Timeout Rate:**
```
count(resolveErrors[type=TIMEOUT]) / total_change_operations
```
- Expected: < 0.1% in production
- Alert if > 1% (indicates poor target matching or large files)

---

## Existing Metrics (Pre-v2)

For backward compatibility, these metrics continue to function:

- `change.total_ms` — Total time for change operation (includes resolve + apply)
- `change.edit_coordinator_ms` — Legacy EditCoordinator timing
- `write.fast_write_ms` — Non-safeWrite file creation time

**Migration Note:** v2 metrics (`resolve_ms`, `apply_ms`) replace `edit_coordinator_ms` when `SMART_CONTEXT_EDITOR_V2=true`.

---

## References

- ADR-042-005 §8: Metrics Specification
- ADR-042-005 §11.1: Performance Benchmarks
- `src/platform/MetricsCollector.ts` — Metrics implementation
- `src/orchestration/pillars/ChangePillar.ts` — change.resolve_ms, change.apply_ms
- `src/orchestration/pillars/BasePillars.ts` — write.safe_patch_ms
