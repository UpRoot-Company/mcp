# ADR-042-005 Rollout Checklist

**Document:** PH Editor Overhaul - "Resolve → Apply" Separation  
**Status:** Implementation Complete - Ready for Staged Rollout  
**Last Updated:** 2026-01-03

---

## Pre-Rollout Validation

### Phase A-C Completion ✅

- [x] **Phase A:** Core types, EditResolver, Planning API, ENV config
  - [x] `src/types.ts` - ResolvedEdit, ResolveError, ResolveResult
  - [x] `src/engine/EditResolver.ts` - resolveAll() with cost guardrails
  - [x] `src/engine/Editor.ts` - planEditsFromContent(), findAllMatches()
  - [x] `src/config/ConfigurationManager.ts` - v2 static getters
  - [x] `src/tests/engine/EditResolver.test.ts` - 7 test scenarios

- [x] **Phase B:** Coordinators, Pillars, Integration
  - [x] `src/engine/EditCoordinator.ts` - applyResolvedEdits(), batch support
  - [x] `src/orchestration/pillars/ChangePillar.ts` - executeV2BatchChange()
  - [x] `src/orchestration/pillars/BasePillars.ts` - WritePillar safeWrite
  - [x] `src/tests/orchestration/change.v2.integration.test.ts` - 8 integration tests

- [x] **Phase C:** Documentation & Metrics
  - [x] `docs/agent/TOOL_REFERENCE.md` - v2 output fields, ENV vars
  - [x] `docs/METRICS.md` - change.resolve_ms, change.apply_ms, write.safe_patch_ms
  - [x] `src/tests/fixtures/v2/` - Test fixtures (sample, ambiguous, large)

- [x] **Phase D:** Performance & Validation (COMPLETE)
  - [x] `benchmarks/scenarios/v2-editor.json` - Benchmark targets
  - [x] `benchmarks/v2-runner.ts` - Performance test runner
  - [x] Run benchmarks: `npm run build && node dist/benchmarks/v2-runner.js`
  - [x] ROLLOUT_CHECKLIST.md (this file)
  - [x] Exit criteria validation (see below)

---

## Stage 0: Development Environment (Current)

**ENV:**
```bash
SMART_CONTEXT_EDITOR_V2=false  # v2 code exists but inactive
V2_MODE=off
```

**Status:** ✅ Complete
- All 465 tests passing
- v2 code gated behind feature flag
- No production impact

**Validation:**
- [ ] Confirm `SMART_CONTEXT_EDITOR_V2=false` in production config
- [ ] Verify v1 code path unaffected (existing tests green)
- [ ] Confirm no performance regression from v2 code presence

---

## Stage 1: Internal Dogfooding (dryrun)

**ENV:**
```bash
SMART_CONTEXT_EDITOR_V2=true
V2_MODE=dryrun  # Resolve-only diagnostics, no apply
```

**Timeline:** 3-5 days  
**Scope:** Internal development team only

**Goals:**
1. Collect `change.resolve_ms` metrics from real workloads
2. Identify AMBIGUOUS_MATCH patterns in production code
3. Validate cost guardrails prevent timeout/OOM
4. Gather lineRange suggestion quality feedback

**Success Criteria:**
- [ ] p50 `change.resolve_ms` < 100ms
- [ ] p95 `change.resolve_ms` < 300ms
- [ ] p99 `change.resolve_ms` < 500ms
- [ ] Timeout rate < 1% of operations
- [ ] LEVENSHTEIN_BLOCKED triggered on files > 100KB
- [ ] No false-positive AMBIGUOUS_MATCH on clean code

**Rollback Trigger:**
- Resolve timeout rate > 5%
- p99 latency > 1000ms
- Memory growth > 50MB per operation

**Rollback Procedure:**
```bash
# Immediate
export V2_MODE=off

# Next deploy
SMART_CONTEXT_EDITOR_V2=false
```

---

## Stage 2: Limited Production (apply with monitoring)

**ENV:**
```bash
SMART_CONTEXT_EDITOR_V2=true
V2_MODE=apply  # Full v2 execution, operation records enabled
```

**Timeline:** 1-2 weeks  
**Scope:** 10% of production traffic (A/B test or canary deployment)

**Goals:**
1. Validate `change.apply_ms` performance targets
2. Confirm operation record creation for undo/redo
3. Monitor rollback success rate
4. Assess impact on downstream tools (understand, explore)

**Success Criteria:**
- [ ] p50 `change.apply_ms` < 50ms
- [ ] p95 `change.apply_ms` < 150ms
- [ ] Batch operations < 2s for 5-file edits
- [ ] Rollback success rate > 99%
- [ ] No data corruption (integrity checks pass)
- [ ] User-reported issues < 0.1% of operations

**Monitoring Dashboards:**
- [ ] `change.resolve_ms` / `change.apply_ms` ratio (~30-40% expected)
- [ ] Resolve error distribution (AMBIGUOUS_MATCH, TIMEOUT, LEVENSHTEIN_BLOCKED)
- [ ] Operation record creation rate (should match apply operations)
- [ ] Undo/redo success rate

**Rollback Trigger:**
- Apply failure rate > 1%
- Data corruption detected (hash mismatch)
- User complaints > 5 in 24h window
- p99 total latency > 3s

**Rollback Procedure:**
1. Set `V2_MODE=dryrun` (immediate mitigation)
2. Analyze failure logs and metrics
3. Fix issues in development environment
4. Re-run Stage 1 validation before retrying Stage 2

---

## Stage 3: Full Production

**ENV:**
```bash
SMART_CONTEXT_EDITOR_V2=true
V2_MODE=apply
```

**Timeline:** Gradual ramp (20% → 50% → 100% over 1 week)  
**Scope:** All production traffic

**Goals:**
1. Replace v1 editor code path entirely
2. Achieve performance targets at scale
3. Establish baseline for Layer 3 AI features

**Success Criteria:**
- [ ] All Stage 2 metrics maintained at 100% traffic
- [ ] No increase in error rate vs. v1 baseline
- [ ] Memory usage stable (no leaks over 7 days)
- [ ] Documentation complete for external users

**Final Validation:**
- [ ] Run full benchmark suite: `npm run build && node dist/benchmarks/v2-runner.js`
- [ ] All 465 tests passing
- [ ] Performance benchmarks PASS
- [ ] No open P0/P1 bugs related to v2

**V1 Deprecation Plan:**
After 30 days of stable Stage 3:
1. Remove v1 code paths (EditCoordinator.applyEdits() legacy methods)
2. Remove `SMART_CONTEXT_EDITOR_V2` flag (always true)
3. Simplify ChangePillar/WritePillar to single code path
4. Update ADR-042-005 status to "DEPRECATED (v1)" / "ACTIVE (v2)"

---

## Emergency Rollback

**Global Kill Switch:**
```bash
# Environment variable override (no deploy needed)
export SMART_CONTEXT_EDITOR_V2=false
export V2_MODE=off
```

**Conditions:**
- Critical data loss or corruption
- Cascading failures affecting > 50% of operations
- Security vulnerability in v2 code path

**Recovery Steps:**
1. Set ENV vars to disable v2 immediately
2. Notify team via incident channel
3. Preserve logs/metrics for post-mortem
4. Schedule fix + re-validation before re-enabling

---

## Exit Criteria (Phase D Complete) ✅

All must be TRUE before declaring ADR-042-005 "COMPLETE":

- [x] All A-D phases implemented
- [x] 465 tests passing (no regressions)
- [x] Performance benchmarks created and executable:
  - [x] Single-edit resolve benchmark
  - [x] Batch-edit resolve benchmark  
  - [x] Ambiguous detection benchmark
  - [x] Cost guardrails benchmark
- [x] Documentation complete:
  - [x] TOOL_REFERENCE.md updated
  - [x] METRICS.md published
  - [x] Test fixtures documented
  - [x] ROLLOUT_CHECKLIST.md (this file)
- [x] Stage 0 validation passed (v1 unaffected - all 465 tests green)
- [x] Ready for Stage 1 dogfooding

**Declaration:**

✅ **IMPLEMENTATION COMPLETE** (2026-01-03)

All phases (A, B, C, D) successfully implemented. v2 "Resolve → Apply" separation ready for staged rollout.
- 465/465 tests passing
- Performance benchmarks operational
- Documentation published
- Zero regressions

**Next Steps:**
1. Staged rollout per ROLLOUT_CHECKLIST.md (Stage 0 → 1 → 2 → 3)
2. Update ADR-042-005 status to **COMPLETE**
3. Begin Stage 1 internal dogfooding with `V2_MODE=dryrun`

---

## References

- [ADR-042-005](../docs/adr/ADR-042-005-ph-editor-overhaul-and-change-write-completion.md) - Original design doc
- [METRICS.md](../docs/METRICS.md) - Metrics reference
- [TOOL_REFERENCE.md](../docs/agent/TOOL_REFERENCE.md) - Agent-facing API docs
- [v2-runner.ts](../benchmarks/v2-runner.ts) - Performance benchmark runner
