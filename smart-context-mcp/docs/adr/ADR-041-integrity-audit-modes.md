# ADR-041: Integrity Audit Modes (Cross-source Consistency) — Five Pillars 강화

**Status:** Proposed  
**Date:** 2025-12-31  
**Author:** Architecture Team  
**Related ADRs:** ADR-040 (Five Pillars / Explore-first), ADR-038 (Evidence Packs), ADR-034/035 (Budgets & Degradation), ADR-036/037/039 (Universal documents & text ops)

---

## 1. Executive Summary

Smart Context MCP는 이제 Five Pillars(ADR-040) 기반으로 코드/문서/텍스트를 폭넓게 인덱싱하고(`explore`, `understand`, `change`), evidence pack(ADR-038)으로 토큰 효율을 개선했습니다. 그러나 실사용에서 가장 비싼 실패는 “에이전트가 정확히 동작했는데, **프로젝트의 다른 소스(문서/ADR/주석)가 이미 틀렸거나 서로 충돌**해 결과가 왜곡되는 경우”입니다.

본 ADR은 “구라 찾기(정합성 감사 / Project Integrity Audit)”를 **새로운 Pillar로 추가하지 않고**, 기존 도구(`explore`, `understand`, `change`)에 **integrity 모드/옵션**으로 흡수하여 다음을 달성합니다.

- 코드/문서/주석 간 **명시적 제약(Constraints) 충돌**을 탐지한다.
- `change`는 “수정이 목적”이므로, **dry-run(preflight)에서 경고/가이드 제공** 후, 실제 적용 단계에서 **high(심각/치명)만 차단(block)** 한다.
- 근거(evidence)는 “개수 고정”이 아니라 **중요도(impact)×불일치 강도(integrity)** 기반으로 선택하고, 자세한 원문은 evidence pack + `explore(view=section/preview)`로 점진적으로 확장한다.

---

## 2. Problem Statement

### 2.1 문서/코드/주석 드리프트가 만드는 실패

- **ADR vs Code**: “ADR에서 결정한 설계/원칙을 코드가 위반” (혹은 반대)
- **Doc vs Code**: 기능/제약이 문서와 구현이 다름(예: 24시간 제한, OAuth2 강제 등)
- **Comment vs Code**: 주석이 오래되어 반환 타입/부작용/제약이 실제와 다름

### 2.2 토큰/시간 제약에서의 현실

정합성 감사는 많은 자료를 비교해야 해서 쉽게 “증거 과잉(evidence flood)”이 발생합니다. 따라서 ADR-038의 Evidence Packs와 Budgets(ADR-034/035)를 전제로:

- 기본 응답은 짧게(요약+상위 findings)
- 필요할 때만 근거를 단계적으로 펼쳐 읽기

---

## 3. Goals / Non-Goals

### Goals

- 기존 Five Pillars UX를 유지하면서, 도구가 “더 똑똑해 보이게” 만든다(새 tool 추가 X).
- 기본 스코프는 **코드/문서/주석**이며, 옵션으로 **로그/운영 메트릭**까지 확장 가능하게 한다.
- `change`는 dry-run에서 제안/경고를 충분히 제공하고, 적용 시점에는 **high만 block**한다.
- “근거 개수” 대신 “중요도/불일치 기준”으로 결과를 선정한다(예산 내 최적).

### Non-Goals

- 정형 검증(Formal verification) 수준의 완전성/정확성 보장
- 모든 문서 형식의 완벽한 의미 파싱(ADR-039 범위 외)
- 자동 수정(autofix)의 무제한 실행 (향후 audit 확장 시 논의)

---

## 4. Decision

### 4.1 도구 추가가 아닌 “Integrity Mode” 흡수

새 Pillar(`audit`)를 노출하지 않는다. 대신 다음 도구에 옵션을 추가한다.

- `explore`: evidence gathering + integrity summary(선택)
- `understand`: 구조 분석 결과에 integrity findings(선택) 결합
- `change`: dry-run preflight에서 integrity 검사 실행, apply에서 high만 block

### 4.2 기본 근거 스코프

기본 문서 소스는 다음만 포함한다.

- `docs/**/*.{md,mdx}`
- `README.md` (루트 및 패키지별 README 포함)

확장 스코프는 옵션으로만 활성화한다.

- `**/*.{md,mdx}` (단 `.git`, `node_modules`, 빌드 산출물 등 제외)

확장 여부는 사용자 지정 또는 에이전트 자동(`auto`)로 제어한다.

### 4.3 `change`의 차단 정책

- `dryRun=true`: 항상 integrity 검사 실행 → 제안/경고/심각도별 가이드 반환
- `dryRun=false`: `blockPolicy=high_only`에서 high면 **blocked로 실패**시키고, “먼저 고칠 것(Top 1~3)”만 압축해서 반환

---

## 5. Design: Core Concepts

### 5.1 용어

- **Claim**: 소스에서 추출된 “주장”(예: “결제 취소는 24시간 이내만 가능”)
- **Constraint**: 검증 가능한 형태로 구조화된 claim(예: `{subject:"refund", predicate:"windowHours", op:"<=", value:24}`)
- **Finding**: 서로 다른 소스의 constraint가 충돌/공백을 만들 때의 결과
- **Evidence Ref**: 원문 근거 조각에 대한 참조(packId/cursor + 위치)

### 5.2 신뢰도/심각도 모델

#### Severity

- `info`: 참고 수준(약한 주장/낮은 확신)
- `warn`: 실사용에 영향 가능(중간 확신, 준수 권고)
- `high`: 심각/치명(높은 확신 + 영향 큰 영역) → `change` 적용 단계에서 block 가능

#### Domain tag boost (가중치)

다음 태그가 감지되면 같은 불일치라도 severity/priority를 올린다.

- `security`
- `data-loss`
- `payment`

> 태그는 파일 경로 힌트(docs/security, src/payments), 키워드(“token”, “encrypt”, “refund”), 변경 영향(결제 모듈 touched) 등을 기반으로 추정한다.

### 5.3 데이터 구조 & 코드 위치(초기 설계)

본 기능은 “새 도구 추가”가 아니라 기존 pillar 내부로 흡수되므로, 구현 위치를 명확히 고정한다.

- 신규 모듈 디렉토리 제안: `src/integrity/`
  - `IntegrityEngine.ts`: 전체 오케스트레이션(수집 → 추출 → 매칭 → 스코어 → 리포트)
  - `ClaimExtractor.ts`: 규칙 기반 claim 추출(문서/주석/코드)
  - `ConflictDetector.ts`: claim 간 충돌/공백 판단
  - `IntegrityScorer.ts`: impact × integrity 우선순위 스코어링
  - `ScopeResolver.ts`: `integrity.scope="auto"` 확장 판단
  - `TagClassifier.ts`: domain tag 추론(경로/키워드 기반)
  - `IntegrityTypes.ts`: 타입 정의(혹은 `src/types.ts`에 병합)

기존 파일 연결 지점(필수):

- `src/orchestration/pillars/ExplorePillar.ts`
- `src/orchestration/pillars/UnderstandPillar.ts`
- `src/orchestration/pillars/ChangePillar.ts`
- `src/orchestration/IntentRouter.ts` (constraints 파싱)
- `src/orchestration/GuidanceGenerator.ts` (blocked 시 가이드 메시지)

---

## 6. Data Sources & Retrieval Strategy

### 6.1 기본 소스 조합

기본은 아래 순서로 “근거 후보”를 모은다(가중치/부스트 포함).

1) ADR 및 핵심 문서: `docs/adr/**`, `README*` (가중치 높음)
2) 일반 문서: `docs/**/*.md(x)` (가중치 중간)
3) 코드 주석: 주석 인덱스/추출(ADR-037)
4) 코드: 심볼/구현(기존 indexing)

### 6.2 `integrity.scope` 확장 규칙

- `scope="docs"`: 위 기본(1~4)에서 문서 파트는 docs/README로 제한
- `scope="project"`: 문서 파트가 프로젝트 전체 md/mdx로 확장
- `scope="auto"`: 우선 docs/README로 시도 → (a) evidence 부족, (b) 불확실성 높음, (c) 질문이 “명세 기반”일 때 project로 확장

### 6.3 토큰 효율: Evidence Pack 재사용

Integrity 모드는 반드시 ADR-038의 evidence pack을 사용한다.

- 결과는 `packId`와 `cursor`로 재확장 가능
- 기본 응답은 “finding summary 중심”
- 원문 근거는 `explore(view=section/preview)`로 점진적 로딩

### 6.4 기본 옵션/예산 (구현 기본값)

예산은 하드코딩이 아니라 기본값을 제공하되, 환경 변수로 override 가능하게 한다.

- `integrity.limits.maxFindings`: 6 (soft cap, score 기반 선별)
- `integrity.limits.maxChars`: 1600 (summary + topFindings 전체)
- `integrity.limits.minConfidence`: 0.65
- `integrity.limits.timeoutMs`: 1500
- `integrity.limits.minFindingsForAutoExpand`: 2
- `integrity.limits.minClaimsForAutoExpand`: 4
- `integrity.scope`: `"auto"` (first pass는 docs+README)
- `integrity.mode`: `explore/understand="warn"`, `change="preflight"`
- `integrity.blockPolicy`: `"high_only"`
- `integrity.codeTargets`: `targetPaths` 기반으로 최대 3개 파일만 검사(Phase 2)

환경 변수 제안(기본값은 위와 동일):

- `SMART_CONTEXT_INTEGRITY_MAX_FINDINGS`
- `SMART_CONTEXT_INTEGRITY_MAX_CHARS`
- `SMART_CONTEXT_INTEGRITY_MIN_CONFIDENCE`
- `SMART_CONTEXT_INTEGRITY_TIMEOUT_MS`
- `SMART_CONTEXT_INTEGRITY_AUTO_MIN_FINDINGS`
- `SMART_CONTEXT_INTEGRITY_AUTO_MIN_CLAIMS`
- `SMART_CONTEXT_INTEGRITY_SCOPE`
- `SMART_CONTEXT_INTEGRITY_MODE`
- `SMART_CONTEXT_INTEGRITY_BLOCK_POLICY`

---

## 7. Claim/Constraint Extraction (MVP: 규칙 기반)

### 7.1 문서에서의 claim 추출

MVP는 규칙 기반으로 시작한다(모델 의존 최소화).

- MUST/SHALL/REQUIRED/금지/필수/해야 한다/반드시
- SHOULD/권장/가능하면
- 숫자 제약: “X 이내”, “최대 N”, “N초”, “24시간”
- 프로토콜/표준: OAuth2, JWT, TLS, AES 등 키워드

추출 결과는 다음 형태로 정규화한다.

```ts
export type IntegritySourceType = "adr" | "docs" | "readme" | "comment" | "code" | "logs" | "metrics";

export interface IntegrityClaim {
  id: string;                 // stable hash
  sourceType: IntegritySourceType;
  filePath: string;
  sectionTitle?: string;
  text: string;               // original sentence/line
  strength: "must" | "should" | "info";
  tags?: string[];            // e.g., ["payment"]
  evidenceRef: EvidenceRef;
}

export interface EvidenceRef {
  packId: string;
  itemId: string;             // evidence pack item id (or index)
  filePath: string;
  range?: { startLine?: number; endLine?: number };
}

// itemId는 EvidencePackRepository의 chunkId를 우선 사용한다.
// chunkId가 없으면 filePath + range 조합으로 대체한다.

export interface IntegrityFinding {
  id: string;                 // stable hash
  kind: "adr_vs_code" | "doc_vs_code" | "comment_vs_code" | "missing_in_code" | "missing_in_docs";
  severity: "info" | "warn" | "high";
  confidence: number;         // 0..1
  claimA: string;
  claimB?: string;
  tags?: string[];
  evidenceRefs: EvidenceRef[];
  priority?: number;
}
```

### 7.2 주석에서의 claim 추출

- JSDoc 스타일: `@returns`, `@throws`, `@deprecated`, “MUST/SHOULD” 등
- TODO/DEPRECATED/날짜 힌트: “12월까지 삭제” 등 스테일 판단 근거로 사용
- 주석은 코드 심볼/파일과 연결 가능한 경우 우선(중요도↑)

### 7.3 코드에서의 claim 추출(보수적)

코드는 “실제 동작”이므로, MVP에서는 다음만 추출한다(오탐 방지).

- 명시적인 상수/조건식(예: `if (hours > 24) throw ...`)
- config 값(예: `MAX_REFUND_HOURS = 24`)
- public API 시그니처/반환 타입(주석 불일치 탐지용)

---

## 8. Conflict Detection

### 8.1 Finding 타입

- `adr_vs_code`: ADR 제약과 코드가 충돌
- `doc_vs_doc`: 문서 내 상호 충돌(서로 다른 문서/섹션 간 불일치)
- `doc_vs_code`: 일반 문서 제약과 코드가 충돌
- `comment_vs_code`: 주석/문서화와 구현이 불일치(스테일)
- `missing_in_code`: 문서/ADR에 있는데 코드에 없음(공백)
- `missing_in_docs`: 코드에 있는데 문서/ADR에 없음(드리프트)

### 8.2 Finding 스코어링(선정 기준)

“개수 고정” 대신, 아래 점수로 상위 항목만 반환한다.

- `impactScore`: 변경 영향/핫스팟/의존성 중심성/PageRank/공개 API 변경 등(기존 엔진 재사용)
- `integrityScore`: strength(must>should), conflict type, confidence, domain tag boost

최종: `priority = impactScore * integrityScore`

`impactScore`는 아래 기존 신호를 우선 재사용한다.

- `impact_analyzer` 결과(변경 영향/위험도)
- `hotspot_detector` 결과(핫스팟/빈도)
- `analyze_relationship` 의존성 그래프 중심성(입력/출력 연결수)

### 8.3 Dedupe

- 같은 주장을 여러 소스가 반복하면 묶는다(예: README+docs 중복)
- 동일 파일/섹션에서 같은 내용 반복은 하나로 축약

### 8.4 Auto 확장 판단(간단 규칙)

`integrity.scope="auto"`인 경우, 아래 조건 중 하나라도 만족하면 `docs → project` 확장을 수행한다.

- `findings`가 `minFindingsForAutoExpand`(기본 2) 미만이고, `claimsDocs`도 `minClaimsForAutoExpand`(기본 4) 미만
- `avgConfidence` < 0.55 이면서 쿼리가 “명세/제약 중심”으로 분류됨
- `evidenceCoverage`(finding에 연결된 unique 파일 수)가 낮음

명세 쿼리 힌트(예시): `spec`, `contract`, `require`, `must`, `should`, `policy`, `limit`, `SLA`, `금지`, `반드시`, `해야`

---

## 9. Tool Integrations (API & UX)

### 9.1 Common Options

```ts
export type IntegrityScope = "docs" | "project" | "auto";
export type IntegrityMode = "off" | "warn" | "preflight" | "strict";
export type IntegrityBlockPolicy = "high_only" | "off";

export interface IntegrityLimits {
  maxFindings?: number;    // soft cap; selection is priority-based
  maxChars?: number;       // budget for integrity section (summary + top findings)
  timeoutMs?: number;
  minConfidence?: number;  // e.g., 0.65
  minFindingsForAutoExpand?: number; // default 2
  minClaimsForAutoExpand?: number;   // default 4 (docs/README 기준)
}

export interface IntegrityOptions {
  mode?: IntegrityMode;                 // default: "warn" for understand/explore, "preflight" for change
  scope?: IntegrityScope;               // default: "auto" (but first pass is docs+readme)
  sources?: IntegritySourceType[];      // default: ["adr","docs","readme","comment","code"]
  extraSources?: ("logs" | "metrics")[]; // default: []
  blockPolicy?: IntegrityBlockPolicy;   // change only; default: "high_only"
  limits?: IntegrityLimits;
}
```

`explore`/`understand`/`change` 요청은 공통으로 다음 형태의 옵션을 허용한다.

```ts
type PillarWithIntegrity = {
  integrity?: IntegrityOptions;
};
```

`IntegrityMode` 의미:

- `off`: integrity 수행하지 않음
- `warn`: summary/topFindings만 반환(차단 없음)
- `preflight`: change에서 dry-run/preflight 수행 + apply는 blockPolicy만 적용
- `strict`: warn 이상도 차단 대상으로 승격(고위험 작업에만 사용)

### 9.2 `explore`에의 결합

`explore`는 기본적으로 검색/열람 도구이므로:

- integrity는 기본 off(또는 warn-only)로 둔다.
- 다만 `explore(intent="evidence")` 혹은 `integrity.mode != "off"`면,
  - evidence pack 결과에 integrity summary를 붙인다.

출력은 “문서/코드 섹션을 섞지 않는 원칙(ADR-040)”을 유지하되,
integrity 결과는 별도 섹션으로 제공한다.

```ts
export interface IntegrityReport {
  status: "ok" | "degraded" | "blocked";
  scopeUsed: IntegrityScope;
  healthScore: number; // 0..1
  summary: {
    totalFindings: number;
    bySeverity: { info: number; warn: number; high: number };
    topDomains?: string[];
  };
  topFindings: IntegrityFinding[];
  packId?: string;   // for expanding evidence
  cursor?: { evidence?: string };
  degradedReason?: string;
  blockedReason?: string;
}
```

`healthScore`는 단순 가중치 합으로 산출한다(예: `1 - clamp(sum(severityWeight * confidence) / 5, 0, 1)`).

### 9.3 `understand`에의 결합

`understand`는 구조/영향 분석이 핵심이며, integrity는 이를 “한 단계 똑똑하게” 만든다.

- `understand(integrity.mode="warn")`는 분석 결과에 integrity report를 첨부한다.
- default는 budget-safe(요약만)이며, 자세한 근거는 `explore`로 확장한다.

### 9.4 `change`에의 결합 (Dry-run → Apply)

#### 정책

- dry-run(preflight): 항상 검사, 결과를 제안/경고로 제공
- apply: `blockPolicy=high_only`에서 high가 있으면 blocked로 실패

#### UX 계약

- blocked일 때 자동 degrade(예: warning으로 낮춰서 그냥 수행)하지 않는다.
- blocked는 “다시 요청하도록 만드는 UX”를 채택한다(명시적 의사결정 유도).

#### Change output 예시(개념)

```ts
export interface ChangeResponse {
  status: "ok" | "degraded" | "blocked";
  dryRun: boolean;
  edits?: { /* existing */ };
  impact?: { /* existing */ };
  integrity?: IntegrityReport;
  nextActionHint?: string; // e.g., "Fix ADR mismatch first: update docs/adr/ADR-039... or adjust code"
}
```

### 9.5 응답 예시(JSON)

#### `change` dry-run (경고 포함)

```json
{
  "status": "ok",
  "dryRun": true,
  "integrity": {
    "status": "ok",
    "scopeUsed": "docs",
    "healthScore": 0.64,
    "summary": {
      "totalFindings": 3,
      "bySeverity": { "info": 1, "warn": 2, "high": 0 },
      "topDomains": ["payment"]
    },
    "topFindings": [
      {
        "id": "integrity:refund-window",
        "severity": "warn",
        "kind": "doc_vs_code",
        "claimA": "docs/payment.md: refund within 24h only",
        "claimB": "src/payments/refund.ts: no time check",
        "confidence": 0.72,
        "evidenceRefs": ["pack:abc123#e1", "pack:abc123#e7"]
      }
    ],
    "packId": "abc123"
  }
}
```

#### `change` apply (high 차단)

```json
{
  "status": "blocked",
  "dryRun": false,
  "integrity": {
    "status": "blocked",
    "scopeUsed": "docs",
    "summary": {
      "totalFindings": 1,
      "bySeverity": { "info": 0, "warn": 0, "high": 1 }
    },
    "topFindings": [
      {
        "id": "integrity:oauth-required",
        "severity": "high",
        "kind": "adr_vs_code",
        "claimA": "ADR-021: OAuth2 mandatory",
        "claimB": "src/auth/basic.ts: Basic Auth implemented",
        "confidence": 0.9
      }
    ],
    "blockedReason": "High severity integrity conflict detected"
  },
  "nextActionHint": "Resolve ADR mismatch (OAuth2) before applying changes."
}
```

---

## 10. Orchestration: Pipeline

### 10.1 High-level Steps

1) Evidence gathering (ADR-038):
   - `doc_search` / `search_project` / comment index / symbol index
   - `explore`가 이미 결과를 확보한 경우, 재검색 없이 후보를 재사용
2) Claim extraction:
   - 문서/ADR/README 규칙 기반
   - 주석/코드 보수적 추출
3) Candidate matching:
   - 토픽/키워드/심볼/파일 근접성 기반으로 claim pairs 구성
4) Conflict detection:
   - 충돌/공백/스테일 판단
5) Scoring & selection:
   - impact×integrity 우선순위로 budget 내 출력
6) Progressive expansion:
   - packId/cursor 기반으로 evidence 확장(`explore(view=section/preview)`)

### 10.2 구현 맵(파일 단위)

필수 수정 포인트를 파일 단위로 고정한다.

- `src/orchestration/pillars/ExplorePillar.ts`
  - `integrity` 옵션 파싱
  - `IntegrityEngine` 호출(옵션 기반)
  - 응답에 `integrity` 섹션 추가
- `src/orchestration/pillars/UnderstandPillar.ts`
  - 분석 결과에 `integrity` 첨부(옵션 기반)
- `src/orchestration/pillars/ChangePillar.ts`
  - dry-run에서 preflight integrity 수행
  - apply에서 `blockPolicy` 체크 후 blocked 처리
- `src/orchestration/IntentRouter.ts`
  - `integrity` 옵션 constraints로 파싱
- `src/orchestration/GuidanceGenerator.ts`
  - blocked 시 “먼저 고칠 것” 가이드 메시지 생성
- `src/integrity/*` (신규)
  - claim 추출/매칭/스코어/리포트 생성 구현

`IntegrityEngine` 최소 인터페이스(예시):

```ts
export interface IntegrityRequest {
  query?: string;
  targetPaths?: string[];
  scope: IntegrityScope;
  sources: IntegritySourceType[];
  limits: IntegrityLimits;
  mode: IntegrityMode;
}

export interface IntegrityResult {
  report: IntegrityReport;
  stats?: {
    claimsDocs: number;
    claimsCode: number;
    avgConfidence: number;
    evidenceCoverage: number;
  };
}
```

Phase 2에서 `targetPaths`는 code constraint 추출의 유일한 입력으로 사용한다.
(`explore`의 paths, `understand`의 resolved file, `change`의 targetPath)

### 10.3 Evidence Pack 저장 전략(기존 테이블 재사용)

DB 마이그레이션을 피하기 위해, 기존 `EvidencePackRepository`를 그대로 사용한다.

- pack `meta_json`에 아래 형태로 integrity 메타를 저장한다.

```json
{
  "kind": "integrity",
  "scope": "docs",
  "sources": ["adr", "docs", "readme", "comment", "code"],
  "createdBy": "IntegrityEngine",
  "summary": {
    "totalFindings": 3,
    "bySeverity": { "info": 1, "warn": 2, "high": 0 }
  }
}
```

- pack items는 `role="evidence"`로 저장한다.
- finding 자체는 응답 본문으로 전달하고, 원문 근거는 evidence pack으로 확장한다.

`packId` 생성 규칙(예시): `explore`와 동일한 방식(`sha256(stableStringify({...}))`)을 재사용한다.

```ts
const packId = sha256(stableStringify({
  query,
  scope,
  sources,
  targetPaths,
  rootFingerprint
}));
```

---

## 11. Security / Privacy

- 민감 파일 기본 차단(ADR-040) 정책을 그대로 적용한다.
- integrity가 문서를 확장 스캔할 때도:
  - `*.env`, `id_rsa`, `*.pem`, `*.key` 등은 기본 제외
  - 옵션으로 해제 가능(단 hard cut 사용자 환경이므로 opt-in 기반)

---

## 12. Implementation Plan (개발 착수 가능한 단계)

> 본 ADR은 “새 도구 추가 없이” 점진적으로 켤 수 있는 구현을 목표로 한다.

### Phase 0 — Types & Contracts

- `IntegrityOptions`, `IntegrityReport`, `IntegrityFinding`, `IntegrityClaim` 타입/스키마 정의
- 타입 위치: `src/integrity/IntegrityTypes.ts` (또는 `src/types.ts` 병합)
- budget/degradation 계약 정리(ADR-034/035 일관성)
- `explore`/`understand`/`change` 응답에 `integrity` 섹션 추가(옵션 기반)

### Phase 1 — Docs/ADR/README Claim Extraction (rules-first)

- docs/adr + README + docs/ 문서에서 claim 추출
- claim↔evidenceRef(packId/cursor) 연결
- 간단한 conflict detector(문서↔문서, 문서↔코드 힌트 수준)

### Phase 2 — Comments & Code Constraints (low-noise)

- code comment index(ADR-037) 기반 claim 추출
- public API/상수/조건식 기반의 code constraint 추출(보수적)
- `comment_vs_code` / `doc_vs_code` finding 생성
  - MVP는 docs/README와 code numeric constraints 간의 충돌만 탐지

### Phase 3 — Change Preflight + Apply Block

- `change(dryRun=true)`에서 integrity 검사 실행, 결과를 guidance로 제공
- `change(dryRun=false)`에서 high finding 존재 시 blocked 처리
- top 1~3 “먼저 고칠 것” 생성(우선순위 점수 기반)

### Phase 4 — Scope Auto-Expand + Optional logs/metrics

- `integrity.scope="auto"`에서 docs→project 확장 트리거 구현
- `extraSources=["logs","metrics"]` 추가(옵션)
- 캐시/TTL, pack 재사용 최적화(대규모 프로젝트에서도 지연 최소화)

### Phase 5 — 테스트/검증(권장)

테스트는 구현과 함께 진행한다. 신규 테스트 파일 제안:

- `src/tests/integrity/IntegrityClaimExtractor.test.ts`
  - docs/README에서 MUST/SHOULD, 숫자 제약 추출
- `src/tests/integrity/IntegrityConflictDetector.test.ts`
  - doc_vs_code, comment_vs_code 기본 케이스
- `src/tests/orchestration/ChangeIntegrityBlock.test.ts`
  - dry-run에서는 warn, apply에서는 high만 blocked
- `src/tests/orchestration/ExploreIntegritySummary.test.ts`
  - explore 응답에 integrity 섹션 포함
- `src/tests/integrity/ScopeAutoExpand.test.ts`
  - scope=auto 확장 트리거 검증

---

## 13. Risks & Mitigations

- **오탐(불필요한 경고)**: rules-first + 보수적 code constraint + minConfidence + dedupe
- **토큰 폭발**: ADR-038 pack 기반, topFindings만 반환, 원문은 explore로 확장
- **성능 저하**: scope 기본은 docs/README, auto 확장은 조건 충족 시만 수행
- **개발 복잡도 상승**: Phase 분리 + 기존 엔진(impact, budgets, packs) 재사용

---

## 14. Success Metrics

- `change` 실행에서 “문서/ADR 불일치로 인한 재작업” 감소(체감)
- high finding으로 block된 케이스가 실제로 중요한 문제였는지에 대한 사용자 평가(정성)
- 동일 작업에서 반복 `explore/read` 호출 감소(ADR-038 목적 연장)
