# ADR-042-004: PH Change/Write (Batch + Latency)

**Status:** Proposed  
**Date:** 2026-01-05  
**Author:** Smart Context MCP Team  
**Related:** `docs/analysis/technical-report.md`, ADR-042-001, ADR-042-002, ADR-042-003, ADR-033 (Six Pillars), ADR-019/030 (Tool Consolidation + Batch Transactions)

---

## 1. 배경 (Context)

ADR-042까지 진행하면서 explore/understand/manage는 성능과 안정성이 개선되었으나, change/write는 상대적으로 개선 효과를 거의 받지 못했습니다. 실제 사용에서는 간단한 수정에도 수분 지연/타임아웃이 발생하고, batch 변경도 동작하지 않는 사례가 확인되었습니다.

대표 증상(요약):

```
MCP tool 'change' ... batchMode + targetFiles + edits
-> MCP error -32001: Request timed out
```

현 구조에서는 change가 단일 파일에만 적용되고, 실패 시 반복적인 자동 보정(fuzzy/normalization)과 문서 추천(doc_search)이 뒤따르면서 지연이 증폭됩니다. 또한 이미 존재하는 batch/transaction 인프라(`EditCoordinator.applyBatchEdits`)가 change 경로에서 활용되지 않고 있습니다.

본 문서는 ADR-042의 긴급 핫픽스로 change/write 경로가 **현재 구현 수준에서 제대로 동작**하도록 만들기 위한 “구현 가능한 설계 + 단계별 개발 계획”을 정의합니다.

---

## 2. 문제 요약 (Pain Points)

1) **change의 멀티파일 미지원**
   - `targetFiles`, `options.batchMode`가 입력에 존재해도 실제 실행은 단일 `targetPath`로만 처리됨.
   - 결과적으로 다른 파일에 대한 edits가 첫 번째 파일로 몰리며 실패 + 자동 보정 반복.

2) **타임아웃 유발 경로**
   - 실패 시 auto-correction(whitespace/structural/levenshtein)을 순차 재시도.
   - `suggestDocUpdates()`가 성공/실패/드라이런과 관계없이 `doc_search`를 실행.
   - large repo에서는 edit + doc_search 조합이 장시간 블로킹을 유발.

3) **write의 불필요한 full-scan 매칭**
   - `read_code(full)` + `edit_coordinator`로 전체 파일을 문자열 매칭.
   - 변경 규모 대비 I/O/정규식 매칭 비용이 큼.

---

## 2.1 현재 구현 스냅샷 (Implementation Snapshot)

핫픽스 설계는 “현재 코드가 실제로 어떻게 동작하는지”를 기준으로 한다.

### change 실행 경로(현재)

- MCP entry: `src/index.ts` → `handleCallTool("change", args)` → `OrchestrationEngine.executePillar("change", args)`
- 인자 매핑: `OrchestrationEngine.mapArgsToIntent()`에서 `args.options.*`가 `intent.constraints.*`로 **flat merge** 된다.
  - 예: `options.dryRun` → `constraints.dryRun`, `options.batchMode` → `constraints.batchMode`
- 실제 적용: `src/orchestration/pillars/ChangePillar.ts`는
  - `targetPath` 1개만 결정하고(`constraints.targetPath || targets[0] || extractTargetFromEdits`)
  - `edit_coordinator`를 **단일 filePath**로 1회 호출해 edit/dryRun을 수행한다.
  - 실패 시 자동 보정(whitespace/structural/levenshtein)을 **연속 재시도**한다.
  - 마지막에 `suggestDocUpdates()`가 `doc_search`를 실행한다(현재는 성공/실패/드라이런과 무관하게 실행될 수 있음).

### batch/transaction 인프라(이미 존재)

- 멀티파일 atomic 적용 엔진은 이미 존재한다.
  - `src/engine/EditCoordinator.ts`: `applyBatchEdits()`는
    - dryRun 시 전체 파일 검증 + (선택) impact preview
    - apply 시 실패가 발생하면 **rollback**을 수행한다(트랜잭션/스냅샷 기반).
- “멀티파일로 적용하는 내부 도구”도 이미 존재한다.
  - `src/index.ts`의 `edit_code` 구현(`editCodeRaw`)은 edits를 파일별로 묶어
    - 1개 파일이면 `EditCoordinator.applyEdits()`
    - N개 파일이면 `EditCoordinator.applyBatchEdits()`를 호출한다.

### write 실행 경로(현재)

- `src/orchestration/pillars/BasePillars.ts`의 `WritePillar`는
  - 기존 파일이면 `read_code(full)`로 전체 내용을 읽고,
  - `edit_coordinator`에 `targetString=existingContent`로 “전체 replace”를 시도한다.
  - 파일이 없으면 빈 파일을 먼저 만들고 같은 방식으로 내용을 넣는다.
- 단점: overwrite 1회만 하면 되는 케이스에서도 “읽기 + 매칭 기반 replace”가 들어가면서 느려질 수 있음.

---

## 2.2 핵심 원인 (Root Causes)

1) change가 “multi-file 입력을 받는 것처럼 보이지만”, 실제 실행은 항상 single-file로 고정되어 있음  
2) 실패 경로에서 자동 보정 + doc_search가 연쇄적으로 실행되어 tail latency를 키움  
3) write가 overwrite 성격임에도 안전한 변경(undo/history)과 빠른 쓰기(write_file) 사이의 “명확한 분기”가 없음  

---

## 3. 목표 / 범위 / 단계 (Goals / Scope / Phases)

### Goals

1) **Batch change 안정화**
   - `targetFiles`/`batchMode`가 실제로 멀티파일 적용으로 이어지도록 한다.
   - 실패 시 자동 롤백(atomic)을 보장한다.

2) **Change/Write latency 개선**
   - 기본 동작에서 불필요한 doc_search 및 반복 자동 보정을 줄인다.
   - 단순 수정(단일/소수 파일)이 “수 초 내”에 완료되도록 한다.

3) **사용자 기대와 문서 일치**
   - ADR/Tool reference에 명시된 batchMode 의미를 구현 수준에서 복원한다.

4) **회귀 방지 및 검증**
   - batch 성공/실패/롤백, write overwrite 경로를 테스트로 고정한다.
   - 타임아웃 재현 여부를 수치로 확인한다.

### Scope (이번 핫픽스에 포함)

- change batch 경로/매핑/rollback 동작 보장
- auto-correction 및 doc_search 호출의 가드레일 적용
- write fast-path 도입(옵션으로 safeWrite 유지)
- 핵심 테스트 추가 및 재현 케이스 고정

### Scope (후속으로 이관)

- Editor 알고리즘 전면 교체(대규모 리팩터링)
- 신규 도구 체계/UX 전면 개편
- 대규모 리디자인(전면적인 파이프라인 교체)

### Phases (현실적인 구현 단계)

- **Phase 0 (Correctness Hotfix)**: batch change를 실제로 동작시키고, write를 fast-path로 전환한다. (기능 정상화 우선)
- **Phase 1 (Latency Guardrails)**: 실패/드라이런에서의 불필요한 비용(doc_search/auto-correction)을 차단하고, fast-fail 규칙을 도입한다. (타임아웃 제거 우선)
- **Phase 2 (Observability + Tuning)**: change/write의 p50/p95를 관측 가능하게 하고, 현장 데이터로 budget/threshold를 조정한다. (implemented: metrics timers 추가 완료)

---

## 4. 결정 (Decision)

다음 4가지 변경을 P0 Hotfix로 채택한다.

1) **change에 batch 경로 도입**
   - `options.batchMode === true` 또는 `targetFiles.length > 1` 이면 batch 실행으로 분기.
   - 내부적으로 `edit_code`/`EditCoordinator.applyBatchEdits`를 사용해 atomic 적용 및 rollback 확보.

2) **멀티파일 edit 매핑 규칙 고정**
   - edit에 `filePath`/`path`가 있으면 해당 파일로 고정.
   - `targetFiles.length === edits.length`이고 edit에 파일 정보가 없으면 **인덱스 순서 매핑**.
   - 이외 케이스는 **명시적 오류**로 빠르게 실패(타임아웃 방지).

3) **auto-correction + doc 추천의 가드레일**
   - batchMode 또는 edits > 1인 경우 auto-correction(levenshtein/structural)을 비활성화.
   - `suggestDocUpdates()`는 성공 + apply(드라이런 아님)일 때만 실행.
   - 필요 시 `options.suggestDocs`/ENV로 opt-in.

4) **write fast-path**
   - `content`가 명시된 경우 “전체 overwrite” 경로를 우선 적용(불필요한 매칭 최소화).
   - 대용량 파일에서는 `write_file` 또는 indexRange 기반 overwrite로 전환(옵션/threshold).

---

## 5. 상세 설계 (개발 착수 가능한 수준)

이 섹션은 “바로 구현 가능한 수준”의 설계를 목표로 한다. 각 항목은 변경 파일/함수/검증 케이스까지 포함한다.

### 5.1 Batch-aware change execution

**Batch 판단 조건**
- `constraints.batchMode === true` (tool option)
- 또는 `targetFiles.length > 1`
- 또는 `edits` 내에 서로 다른 `filePath/path`가 존재

**Edit 매핑 규칙**

입력의 `edits[]`를 “파일별 edit 묶음”으로 변환한다.

1) edit에 `filePath`/`path` 존재 시 그대로 사용  
2) edit에 파일 정보가 없고, `targetFiles.length === edits.length`이면 **인덱스 순서로 매핑**  
3) 그 외는 명시적 에러로 종료:
   - errorCode: `MULTI_FILE_MAPPING_REQUIRED`
   - message: “멀티파일 변경에서 각 edit의 filePath가 필요하거나, targetFiles와 edits 길이가 동일해야 합니다.”

#### 5.1.1 파일 매핑 알고리즘(의사코드)

```ts
function mapEditsToFiles(targetFiles: string[], rawEdits: any[], fallbackTarget?: string) {
  const byFile = new Map<string, any[]>();

  const hasAnyFileOnEdit = rawEdits.some(e => typeof e?.filePath === "string" || typeof e?.path === "string");
  const canIndexMap = !hasAnyFileOnEdit && targetFiles.length > 0 && targetFiles.length === rawEdits.length;

  for (let i = 0; i < rawEdits.length; i++) {
    const edit = rawEdits[i];
    const explicit = (edit?.filePath ?? edit?.path);
    const filePath = typeof explicit === "string" && explicit.trim()
      ? explicit.trim()
      : (canIndexMap ? targetFiles[i] : fallbackTarget);

    if (!filePath) throw MULTI_FILE_MAPPING_REQUIRED;
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath)!.push(edit);
  }

  return byFile;
}
```

핵심 의도:
- 멀티파일에서 “의도치 않게 모든 edit가 첫 번째 파일로 몰리는 현상”을 원천 차단한다.
- 불명확한 입력은 빠르게 실패시키고, 클라이언트/상위 에이전트가 filePath를 명시하도록 유도한다.

#### 5.1.2 Batch + Impact 처리 정책

batch에서 impact는 비용이 크므로 “상한 기반”으로 제한한다.

- 기본값: batch impact 비활성화 (`batchImpactLimit = 0`)
- 활성화 조건:
  - `options.includeImpact=true` + (`options.batchImpactLimit` > 0 또는 ENV 설정)
- 상한:
  - 최대 N개 파일만 impact preview 포함 (N = `batchImpactLimit`)

관련 옵션/ENV:
- `options.batchImpactLimit` (tool option)
- `SMART_CONTEXT_CHANGE_BATCH_IMPACT_LIMIT` (env, 기본 0)

**실행 경로**

- **DryRun**
  - 파일별로 `edit_coordinator` (dryRun=true) 실행 → diff 수집
  - 결과를 `plan.steps[]`에 누적(파일별 diff 포함)
  - batch dryRun은 “파일별 검증이 모두 성공해야 성공”으로 처리한다.

- **Apply**
  - `edit_code`를 통해 `EditCoordinator.applyBatchEdits` 호출(이미 구현된 atomic path 재사용)
  - 실패 시 `applyBatchEdits`가 스냅샷 기반 rollback을 수행한다.

**응답 형태(확장)**

```ts
{
  success: boolean;
  operation: "plan" | "apply";
  results?: Array<{ filePath: string; success: boolean; diff?: string; error?: string }>;
  rollbackAvailable?: boolean;
}
```

**구현 지점(파일/함수)**

- `src/orchestration/pillars/ChangePillar.ts`
  - `execute()`에 batch 분기 추가
  - 신규 helper:
    - `shouldUseBatch(targetFiles, rawEdits, constraints): boolean`
    - `mapEditsToFiles(targetFiles, rawEdits, defaultTargetPath): Map<string, any[]>`
    - `executeBatchDryRun(...)`, `executeBatchApply(...)`
  - batch path에서는 단일 `targetPath` 기반 `normalizeEdits(rawEdits, targetPath)`를 그대로 쓰지 않고,
    - per-file로 `normalizeEdits(rawEditsForFile, filePath)` 호출
    - 그 결과를 `edit_coordinator` 또는 `edit_code`에 전달한다.

#### 5.1.2 batch에서 impact/guide 처리(현실적 제약)

현재 `ChangePillar`는 single-file 기준으로 impact tools(`impact_analyzer`, `analyze_relationship`, `hotspot_detector`)를 병렬 실행한다.

핫픽스 단계에서는 다음으로 제한한다.
- batch **dryRun**: impact는 기본적으로 끈다(파일 수만큼 병렬 실행하면 오히려 타임아웃을 유발할 수 있음).
- batch **apply**: `includeImpact === true`여도 “대표 파일 1개 또는 상위 N개”로 제한하거나, Phase 2로 이관한다.

이 결정은 “정상 동작 + 타임아웃 제거”를 우선하기 위한 것이다.

---

### 5.2 Auto-correction budget 제한

기본 원칙: **batch에서는 자동 보정을 하지 않는다.** (실패 시 빠르게 실패하고, 사용자/상위 오케스트레이션이 anchor를 보강하도록 유도)

- batchMode 또는 멀티파일로 판정된 경우:
  - `maxMatchAttempts = 1` (재시도 없음)
  - `allowNormalization = false`
  - `allowLevenshtein = false`

- 단일 파일이라도 파일 크기 > N MB 또는 targetString이 매우 짧은 경우:
  - levenshtein 자동 시도 차단

튜닝 파라미터(Phase 2):

- `SMART_CONTEXT_CHANGE_MIN_LEVENSHTEIN_TARGET_LEN` (default: `24`)
- `SMART_CONTEXT_CHANGE_MAX_LEVENSHTEIN_FILE_BYTES` (default: `262144`)

**구현 지점**

- `src/orchestration/ChangeBudgetManager.ts`
  - `create()`에 `batchMode`/`editCount` 파라미터를 추가하거나,
  - `ChangePillar.execute()`에서 batch 판정 시 budget을 강제로 conservative로 다운그레이드한다.
- `src/orchestration/pillars/ChangePillar.ts`
  - autoCorrectionAttempts 생성 전에 batch 판정이면 `attempts=[]`로 처리한다.

---

### 5.3 Doc suggestion gating

`suggestDocUpdates()`는 다음 조건을 모두 만족할 때만 실행한다.

1) `finalResult.success === true`
2) `dryRun === false`
3) (옵션) `options.suggestDocs === true` 또는 ENV `SMART_CONTEXT_CHANGE_SUGGEST_DOCS=true`

실패/드라이런 시에는 doc_search를 호출하지 않는다.

**구현 지점**

- `src/orchestration/pillars/ChangePillar.ts`
  - `relatedDocs = await this.suggestDocUpdates(...)` 호출을
    - `if (!dryRun && finalResult.success && shouldSuggestDocs(constraints))`로 감싼다.
  - `shouldSuggestDocs`는 다음을 지원한다:
    - `constraints.suggestDocs === true` (tool option)
    - 또는 ENV `SMART_CONTEXT_CHANGE_SUGGEST_DOCS === "true"`

---

### 5.4 Write fast-path

write는 “생성/overwrite” 목적이므로, 매칭 기반 edit를 최소화한다.

1) `content`가 명시된 경우:
   - 기본은 `write_file`로 바로 overwrite (빠른 경로)
   - 필요 시 `options.safeWrite=true`일 때만 edit_coordinator 사용

2) 대용량 파일:
   - threshold 초과 시 자동 fast-path 적용

3) 생성 파일:
   - 기존 로직 유지 (디렉토리 생성 + write)

**write 옵션 계약(제안)**

- `options.safeWrite?: boolean` (default: `false`)
  - `true`이면 기존 방식(읽기+edit_coordinator)을 사용해 history/undo를 남긴다.
  - `false`이면 fast-path(`write_file`)로 overwrite한다.

**구현 지점**

- `src/orchestration/pillars/BasePillars.ts` (WritePillar)
  - `content`가 주어진 경우:
    - `safeWrite !== true`면 `write_file` 호출로 overwrite
    - `safeWrite === true`면 기존 `edit_coordinator` 경로 유지
- `src/index.ts`
  - write tool input schema에 `options.safeWrite`(또는 top-level `safeWrite`)를 추가해 클라이언트에서 제어 가능하게 한다.

**주의(트레이드오프)**

- `write_file`은 빠르지만 `EditCoordinator` history(undo/redo)와 분리된다.
- 안전 모드(`safeWrite=true`)는 느릴 수 있으나 “되돌리기”가 필요할 때 선택 가능해야 한다.

#### 5.4.1 생성/overwrite의 분리(실제 구현 디테일)

write는 “파일 생성”과 “파일 overwrite”를 구분해야 한다.

- 파일이 없고 `content`가 비어있음: 현재와 같이 empty file 생성 + 안내(OK)
- 파일이 없고 `content`가 있음:
  - fast-path에서는 `write_file`로 즉시 생성 + 내용 기록(디렉토리는 `edit_code(createMissingDirectories)` fallback)
- 파일이 있고 `content`가 있음:
  - fast-path에서는 `write_file` overwrite
  - safeWrite에서는 기존 `edit_coordinator` replace(undo 지원)

---

### 5.5 Tool Contract (입력/호환성)

핫픽스는 기존 호출과의 호환성을 유지한다.

- 단일 파일 change: 기존과 동일(legacy `target/replacement` 지원 유지)
- 멀티파일 change:
  - 권장: edits에 `filePath`를 명시
  - 예외 허용: `targetFiles.length === edits.length`일 때 index 매핑
  - 그 외: 빠르게 에러(명시적 메시지)

추가 옵션:

- `options.suggestDocs`: 성공 apply 후 doc 추천 활성화
- `options.batchImpactLimit`: batch impact preview 상한
- `options.safeWrite`: write를 edit_coordinator 경로로 강제

예시(권장):

```json
{
  "intent": "Modify A and B together",
  "targetFiles": ["a.ts", "b.ts"],
  "edits": [
    { "filePath": "a.ts", "targetString": "old", "replacement": "new" },
    { "filePath": "b.ts", "targetString": "old", "replacement": "new" }
  ],
  "options": { "batchMode": true, "dryRun": false }
}
```

---

### 5.6 Observability (선택이지만 권장)

타임아웃은 “원인”이 아니라 “결과”이므로, Phase 2에서 최소 계측을 추가한다.

- `change.total_ms` (change tool end-to-end)
- `change.edit_coordinator_ms` (per-file)
- `change.edit_code_ms` (batch apply)
- `change.doc_suggest_ms` (doc_search 포함)
- `write.total_ms`

구현은 `src/utils/MetricsCollector.ts`의 `metrics`를 활용한다.

예시(스냅샷 조회):

```json
{ "command": "metrics" }
```

---

## 6. 작업 계획 (Implementation Plan)

1) Phase 0: ChangePillar batch 분기 추가 (Correctness)
   - `src/orchestration/pillars/ChangePillar.ts`
   - editsByFile 생성 + 매핑 규칙 적용
   - batch dryRun: per-file edit_coordinator
   - batch apply: edit_code 호출

2) Phase 1: Auto-correction 제한 로직 추가 (Latency)
   - `src/orchestration/ChangeBudgetManager.ts`
   - `src/orchestration/pillars/ChangePillar.ts`

3) Phase 1: Doc suggestion gating (Latency)
   - `src/orchestration/pillars/ChangePillar.ts`

4) Phase 0: Write fast-path (Correctness + Latency)
   - `src/orchestration/pillars/BasePillars.ts` (WritePillar)
   - `src/index.ts` (write tool schema에 options 추가)

5) Phase 0/1: 테스트 추가 (Regression Lock)
   - `src/tests/change.integration.test.ts`
   - 신규: batch rollback integration test
   - write fast-path test (overwrite vs safeWrite)

### 6.1 테스트 설계(구체)

- `src/tests/change.batch.integration.test.ts` (신규 권장)
  - **success**: 2개 파일에 각각 다른 targetString 치환 → 둘 다 변경됨
  - **rollback**: 2개 파일 중 1개는 targetString mismatch → 전체 롤백(둘 다 원상)
  - **mapping error**: targetFiles=2, edits=1(또는 filePath 미명시) → `MULTI_FILE_MAPPING_REQUIRED`

- `src/tests/write.fastpath.integration.test.ts` (신규 권장)
  - **fast overwrite**: 기존 파일에 content overwrite → 내용이 정확히 반영
  - **safeWrite**: safeWrite=true일 때 edit_coordinator 경로를 타는지(undo 가능 여부는 manage undo로 검증)

테스트는 “현재 재현되는 timeout 케이스”를 최대한 작은 fixture로 고정한다(대형 레포 의존 금지).

### 6.2 코드 변경 체크리스트(구체)

- `src/orchestration/pillars/ChangePillar.ts`
  - batch 판정: `constraints.batchMode || targetFiles.length>1 || edits에 다중 filePath`
  - 파일별 edit 분해: `mapEditsToFiles()`
  - 파일별 normalize: `normalizeEdits(rawEditsForFile, filePath)`
  - batch dryRun: 파일별 `edit_coordinator(dryRun=true)` 호출 + 결과 취합
  - batch apply: `edit_code({ edits:[{filePath, ...}], dryRun:false })` 호출로 atomic 적용
  - auto-correction/doc-suggest: batch 또는 dryRun/실패에서 실행 금지

- `src/orchestration/ChangeBudgetManager.ts`
  - batch(또는 edits>1)에서 `maxMatchAttempts=1`, `allowNormalization=false`, `allowLevenshtein=false`

- `src/orchestration/pillars/BasePillars.ts` (WritePillar)
  - `content`가 있으면 기본은 `write_file`로 overwrite
  - `safeWrite=true`일 때만 `edit_coordinator` 경로 사용
  - 생성 시 디렉토리 없음: 기존 fallback(`edit_code` createMissingDirectories) 유지

- `src/index.ts`
  - write tool schema에 `options.safeWrite` 추가(클라이언트에서 제어 가능)
  - (선택) change tool schema에 `options.suggestDocs` 추가(이미지는 env로도 제어 가능)

---

## 7. 검증/테스트 (Validation)

- **Batch 성공 케이스**: 2개 파일 동시 수정 → 둘 다 변경
- **Batch 실패 케이스**: 1개 실패 시 전체 롤백
- **Timeout 방지**: 동일 시나리오(재현 스크립트/테스트)에서 change가 타임아웃 없이 완료
- **Write fast-path**: large file overwrite가 1회 I/O로 완료

---

## 8. 리스크 / 롤백

**리스크**
- batch 매핑 규칙이 기존 사용자를 혼란시킬 수 있음(명확한 에러 메시지 필요)
- write fast-path는 history/undo 경로를 우회할 수 있음

**롤백**
- `options.safeWrite=true`로 기존 안전 경로 강제
- `SMART_CONTEXT_CHANGE_SUGGEST_DOCS=false` 기본 유지

---

## 9. 성공 기준 (Success Criteria)

1) change/write의 단순 수정이 일관되게 빠르게 완료(현장 타임아웃 재현 제거)
2) change batch edit 성공/실패/rollback이 deterministic (테스트로 고정)
3) multi-file change 입력이 “지원한다고 문서에 쓰여있는 만큼” 실제로 동작
