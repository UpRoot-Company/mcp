# ADR-040: Five Pillars Toolset Consolidation (Explore-first)

**Status:** Proposed  
**Date:** 2025-12-31  
**Author:** Architecture Team  
**Related ADRs:** ADR-033 (Six Pillars), ADR-038 (Evidence Packs), ADR-034/035 (Budgets & Degradation), ADR-036/037/039 (Docs/TXT/Office/PDF ingestion)

---

## 1. Executive Summary

Smart Context MCP는 현재 “Six Pillars” (`understand`, `change`, `navigate`, `read`, `write`, `manage`)를 외부 MCP 도구로 노출합니다. 그러나 실사용 관점에서 `navigate`와 `read`는 사용자의 멘탈 모델이 겹치며(“찾기/열기/읽기”), 에이전트는 이 둘을 반복 호출하면서 **중복된 컨텍스트 전송(토큰 소진)** 과 **불필요한 왕복**을 유발합니다.

본 ADR은 외부 도구를 **6개 → 5개**로 통폐합하여, `navigate + read`를 단일 도구 **`explore`** 로 합치는 것을 결정합니다.

새로운 외부 공개 도구 세트(5 pillars)는 다음과 같습니다.

- `explore` — 탐색 + 읽기 + evidence pack (기존 `navigate`, `read` 대체)
- `understand`
- `change`
- `write`
- `manage`

핵심 설계 원칙은 다음과 같습니다.

1) **“full read 허용”**: `explore`는 파일 전체 읽기(full)를 포함합니다(기존 `read`의 full 기능을 보존).  
2) **기본값은 토큰/시간 안전**: `explore`는 기본적으로 preview/section 중심으로 동작하고, full은 명시적으로 요청될 때 수행합니다.  
3) **ADR-038 Evidence Packs를 기본 내장**: `explore`는 packId/cursor 기반 progressive disclosure를 제공하여 중복 읽기/중복 토큰을 줄입니다.  
4) **내부 도구(`doc_search`, `doc_section` 등)는 유지**: 외부 toolset만 5개로 단순화하고, 내부적으로는 문서/코드 파이프라인을 계속 재사용합니다.
5) **민감 파일 기본 차단**: `.env`, `id_rsa` 등 민감 파일은 기본적으로 차단하며, 명시적 opt-in 없이 원문을 반환하지 않습니다.

---

## 2. Problem Statement

### 2.1 사용자/에이전트 관점의 문제

- `navigate`와 `read`의 경계가 애매합니다.
  - 사용자가 원하는 것은 보통 “관련 있는 것들을 찾고, 필요한 만큼만 읽고, 원하면 더 깊게 읽기”인데, 이 흐름이 도구 경계로 분절됩니다.
- 에이전트가 `navigate → read → navigate → read` 식으로 왕복하며 같은 파일/섹션을 반복 열람해 토큰과 시간을 소진합니다.
- 문서(.md/.mdx/.txt/.log/.docx/.xlsx/.pdf) 지원이 커질수록, “탐색+열람”은 더 자주 결합되어야 합니다(ADR-036~039).

### 2.2 시스템 관점의 문제

- “찾기”와 “읽기”를 분리한 도구 설계는 구현은 단순해 보이지만, 실제로는:
  - 결과를 합치기 위한 orchestration이 더 복잡해지고,
  - 토큰 폭발(too much evidence)과 응답 지연을 야기합니다.
- ADR-038의 Evidence Pack을 활용하려면 “탐색 결과”와 “읽은 근거”가 동일 요청 컨텍스트에서 결합되는 편이 유리합니다.

---

## 3. Goals / Non-Goals

### Goals

- 외부 공개 도구를 5개로 단순화하여 인지 부하를 줄인다.
- `explore` 한 번으로 “찾기→읽기(섹션/프리뷰)→필요 시 full”까지 수행할 수 있게 한다.
- Evidence Packs(ADR-038)를 `explore`의 기본 기능으로 포함해 중복 읽기/중복 토큰을 줄인다.
- 기존 문서/코드 인덱싱 파이프라인(ADR-036~039)을 최대한 재사용한다.
- Degradation(ADR-034/035) 계약을 유지하고, 부분 결과/잘림/timeout 등을 투명하게 표시한다.

### Non-Goals

- 이번 ADR에서 “구라 감지(정합성 감사 / integrity audit)”를 외부 도구로 새로 추가하지 않는다.
  - 단, `explore`는 audit 엔진이 요구하는 evidence gathering 기반을 제공하도록 설계한다(후속 ADR).
- 단번에 모든 레거시 호출자를 완벽하게 호환시키는 것을 목표로 하지 않는다.
  - 대신, 단계적 마이그레이션/토글(옵션) 경로를 제공할 수 있다(아래 참조).

---

## 4. Decision

### 4.1 New Public Toolset (5 Pillars)

외부 MCP 도구는 다음 5개만 노출합니다.

| New Tool | 역할 | 기존 대응 |
|---|---|---|
| `explore` | 탐색 + 읽기 + evidence pack | `navigate` + `read` |
| `understand` | 구조/의존성/영향/요약(확장 가능: integrity mode) | `understand` |
| `change` | 안전한 수정(dryRun/transaction/impact) + preflight 확장 가능 | `change` |
| `write` | 생성/템플릿/파일 작성 | `write` |
| `manage` | 상태/히스토리/리인덱스/테스트/운영 | `manage` |

> 주의: 내부 레지스트리에는 `doc_search`, `doc_section`, `doc_toc`, `doc_references` 등 internal tools가 계속 존재할 수 있으며, `explore`는 이를 활용합니다.

### 4.2 Explore-first Contract

`explore`는 “찾기 + 열람”을 하나의 계약으로 제공합니다.

- 기본 동작: preview/section 중심(토큰 효율)
- 명시적 요청 시: full read 수행
- evidence pack 내장: `packId`로 재사용 가능

### 4.3 Compatibility Strategy (선택)

본 ADR은 **Hard cut**을 채택합니다.

- 즉시 외부 공개 도구를 5개로 변경하고, `navigate`/`read`는 제거합니다.
- 내부 레지스트리(`doc_search`, `doc_section`, `search_project`, `read_file` 등)는 유지하며, `explore`가 이를 활용합니다.

---

## 5. Detailed Design (개발 착수 가능한 수준)

### 5.1 `explore` 입력 스키마 (개념 + JSON Schema)

`explore`는 “무엇을/얼마나/어떻게” 읽을지 명시할 수 있어야 하며, 동시에 기본값은 안전해야 합니다.

#### Conceptual Interface

```ts
export type ExploreIntent = "auto" | "find" | "read" | "evidence";
export type ExploreView = "auto" | "preview" | "section" | "full";

export interface ExploreLimits {
  maxResults?: number;     // overall items returned (per group)
  maxChars?: number;       // total response content budget (across all items, excluding metadata)
  maxItemChars?: number;   // optional cap per item (default derived from maxChars/maxResults)
  maxBytes?: number;       // hard cap for raw file reads (full)
  maxFiles?: number;       // when paths include directories, cap traversal
  timeoutMs?: number;      // end-to-end tool budget
}

export interface ExploreSectionSelector {
  sectionId?: string;
  headingPath?: string[];
  includeSubsections?: boolean;
}

export interface ExploreArgs {
  query?: string;          // search query (when intent=find/auto)
  paths?: string[];        // explicit targets (files/dirs) for reading; directories allowed
  intent?: ExploreIntent;  // default "auto"
  view?: ExploreView;      // default "auto"
  section?: ExploreSectionSelector;
  packId?: string;         // reuse ADR-038 evidence pack
  cursor?: { items?: string; content?: string }; // dual cursor: items paging + content paging
  include?: { docs?: boolean; code?: boolean; comments?: boolean; logs?: boolean };
  fullPaths?: string[];    // when view=full and multiple paths are given, only these receive full content
  allowSensitive?: boolean; // opt-in to read sensitive paths (default false)
  allowBinary?: boolean;    // opt-in to read binary/non-text (default false)
  allowGlobs?: boolean;     // opt-in to accept globs in paths (default false)
  limits?: ExploreLimits;
}
```

#### JSON Schema (초기 버전)

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "paths": { "type": "array", "items": { "type": "string" } },
    "intent": { "type": "string", "enum": ["auto", "find", "read", "evidence"] },
    "view": { "type": "string", "enum": ["auto", "preview", "section", "full"] },
    "section": {
      "type": "object",
      "properties": {
        "sectionId": { "type": "string" },
        "headingPath": { "type": "array", "items": { "type": "string" } },
        "includeSubsections": { "type": "boolean" }
      }
    },
    "packId": { "type": "string" },
    "cursor": {
      "type": "object",
      "properties": {
        "items": { "type": "string" },
        "content": { "type": "string" }
      }
    },
    "include": {
      "type": "object",
      "properties": {
        "docs": { "type": "boolean" },
        "code": { "type": "boolean" },
        "comments": { "type": "boolean" },
        "logs": { "type": "boolean" }
      }
    },
    "fullPaths": { "type": "array", "items": { "type": "string" } },
    "allowSensitive": { "type": "boolean" },
    "allowBinary": { "type": "boolean" },
    "allowGlobs": { "type": "boolean" },
    "limits": {
      "type": "object",
      "properties": {
        "maxResults": { "type": "number" },
        "maxChars": { "type": "number" },
        "maxItemChars": { "type": "number" },
        "maxBytes": { "type": "number" },
        "maxFiles": { "type": "number" },
        "timeoutMs": { "type": "number" }
      }
    }
  }
}
```

### 5.2 `explore` 출력 포맷 (Evidence-first)

`explore`는 기존 도구들과 동일한 envelope(`success/status/message/...`)를 사용합니다.
또한 본 ADR에서는 “문서 vs 코드” 결과를 **의도적으로 섞지 않고**, 그룹으로 나누어 제공합니다(향후 audit/integrity 결합 시 충돌 분석에 유리).

> `toc/references/skeleton` 같은 세부 기능은 외부 도구로 별도 노출하지 않고, `explore(view=preview|section)` 내부 구현에서 필요에 따라 `doc_toc`/`doc_references`/skeleton-first(ADR-014) 경로를 활용하여 **preview/section 결과로 표현**합니다.

```ts
export type ExploreItemKind = "document_section" | "file_preview" | "file_full" | "symbol" | "directory";

export interface ExploreRange {
  startLine?: number;
  endLine?: number;
}

export interface ExploreItem {
  kind: ExploreItemKind;
  filePath: string;
  title?: string;
  score?: number;
  range?: ExploreRange;
  preview?: string;     // default
  content?: string;     // only when view=full or explicitly requested
  metadata?: Record<string, unknown>;
  why?: string[];       // ranked reasons / signals (token-friendly)
}

export interface ExploreData {
  docs: ExploreItem[];
  code: ExploreItem[];
}

export interface ExploreResponse {
  success: boolean;
  status: "ok" | "no_results" | "invalid_args" | "blocked" | "error";
  message?: string;
  query?: string;
  data: ExploreData;
  pack?: { packId: string; hit: boolean; createdAt: number; expiresAt?: number };
  next?: { itemsCursor?: string; contentCursor?: string };
  degraded?: boolean;
  reasons?: string[];
  stats?: Record<string, unknown>;
}
```

### 5.3 Routing Rules (의사결정 트리)

`explore`는 입력의 형태에 따라 내부적으로 다음 경로를 선택합니다.

1) `paths`가 존재하고 `query`가 비어있다  
   - `view=full`: `read_file`/`doc_section(mode=raw)` 등 “원문 읽기” 경로로 이동(단, maxBytes/maxChars 준수)  
     - 여러 `paths`가 주어졌고 일부만 full을 원하면 `fullPaths`로 제한  
     - 민감 파일/바이너리 파일은 기본 차단(아래 Safety 규칙 참조)  
   - `view=section|preview|auto`: doc/code 종류를 판별해 섹션/프리뷰를 반환  

2) `query`가 존재한다 (`intent=find|auto`)  
   - 문서 후보: `doc_search` (ADR-036~039의 문서 인덱싱/검색)  
   - 코드 후보: `search_project` (기존 검색 엔진)  
   - 결과 반환: docs/code를 섞지 않고 `data.docs`, `data.code`로 분리하여 반환  
   - “필요한 만큼만 읽기”: 문서는 `doc_section(preview)` 중심, 코드는 `read_fragment`/skeleton 기반(기본 view=auto)  
   - `packId` 제공: 이후 “더 읽기”는 같은 packId로 `cursor` 기반 확대

3) `intent=evidence`  
   - preview/section 중심으로 근거팩 구성(ADR-038)  
   - full은 기본 금지(명시적 view=full에서만)

4) `view=preview|section`에서의 “구조적 읽기”  
   - 문서: `doc_section(mode=preview|summary)` 및 내부적으로 `doc_toc`/`doc_references`를 활용해 preview를 구성할 수 있음(표현은 `ExploreItem.preview`/`metadata`로 통일)  
   - 코드: skeleton-first(ADR-014) 스타일의 preview를 `ExploreItem.preview`로 제공하고, 구간 읽기는 `range` 기반으로 section/fragment를 제공  

### 5.4 Token & Time Safety Defaults

`explore`는 full을 허용하지만, 기본값은 반드시 안전해야 합니다.

- `view=auto` 기본: `preview` 또는 `section`으로만 응답(원문 자동 첨부 금지)
- `view=full`은 명시적으로 요청해야 하며, 반드시 `limits.maxBytes` 또는 `limits.maxChars`의 상한을 둡니다.
- `view=full`에서 상한을 초과하면 **자동 truncate로 부분 원문을 반환하지 않고**, `success: false`, `status: "blocked"`로 실패하며 “상한을 늘려 다시 요청”하도록 안내합니다.
- `view=preview|section`에서는 부분 결과/잘림이 발생할 수 있으며, 이 경우 `degraded: true` + `reasons: ["budget_exceeded", "truncated"]` 등으로 투명하게 표시합니다.

#### Safety: 민감 파일/바이너리 차단

민감 파일 차단은 “경로 패턴만”이 아니라, **확장자 + 파일명 + 디렉토리 규칙을 혼합**한 방식으로 구현합니다.

- 기본 차단(예시 규칙):
  - 디렉토리: `.ssh/**`, `.gnupg/**`
  - 파일명: `.env`, `.env.*`, `id_rsa`, `id_ed25519`, `known_hosts`, `authorized_keys`
  - 확장자: `*.pem`, `*.p12`, `*.pfx`, `*.key`, `*.kdbx`
- 차단된 경로를 `view=full`로 요청하면:
  - `success: false`, `status: "blocked"`, `message`에 사유를 포함
- 예외 허용:
  - `allowSensitive=true`가 명시된 경우에만 민감 파일 full read 허용(여전히 maxBytes/maxChars 적용)
  - 바이너리는 `allowBinary=true`가 명시된 경우에만 허용(기본은 텍스트 기반 결과만)

#### Directories & Globs

- `paths`에 디렉토리를 허용하며, 내부적으로 파일 목록을 확장합니다(반드시 `limits.maxFiles` 상한 적용).
- 디렉토리 확장 기본값(권장):
  - `depth=5`
  - 파일 선택은 **최근 수정순(mtime desc)** 을 1순위로 하되, 확장자/파일 종류(문서 vs 코드)가 완전히 무시되지 않도록 “soft priority”를 적용합니다.
    - 예: 전체 선택량 중 일부(예: 20%)는 “선호 확장자(문서/코드)” 풀에서 보정하여 포함
    - 선호 확장자 풀은 `include`(docs/code/comments/logs)와 `DocumentIndexer.isSupported` 기준을 함께 사용
- glob은 기본 비허용이며, `allowGlobs=true`일 때만 입력으로 수용합니다(보안/성능/예측성 목적).

### 5.5 Evidence Pack Integration (ADR-038)

`explore`는 다음을 표준으로 포함합니다.

- `packId`가 없는 요청: 새 pack 생성
- `packId`가 있는 요청: 동일 컨텍스트 재사용(중복 전송 방지)
- `cursor`를 사용한 점진적 확장:
  - “더 많은 결과/더 긴 내용/더 넓은 범위”를 안전하게 제공

#### packId 구성 원칙(권장)

- **포함**: `query`(정규화), include 옵션(docs/code/comments/logs), 대상 스코프(roots/paths), intent(대분류)
- **불포함**: `limits.*`(예산), `view`(표현 방식), `cursor`(페이지네이션 상태)
  - 이유: 같은 주제/스코프에서 budget/view를 바꿔가며 점진적으로 읽을 수 있어야 하며, pack의 재사용성이 중요합니다.

### 5.6 Tool Removal & Migration (실제 운영 체크리스트)

#### MCP 노출 변경

- 제거: `navigate`, `read`
- 추가: `explore`
- 유지: `understand`, `change`, `write`, `manage`

#### Client config (예: includeTools)

```json
{
  "includeTools": ["explore", "understand", "change", "write", "manage"]
}
```

---

## 6. Implementation Plan (Phased)

### Phase 0 — API Surface (Tool list) 전환

- 외부 노출 도구 목록을 5개로 변경
- `explore` 도구 스텁/라우팅 추가(최소 기능: paths 읽기 + query 찾기)
- 기존 내부 도구(`doc_search`, `doc_section`, `search_project`, `read_file`)는 그대로 유지

### Phase 1 — Explore MVP (Docs + Code)

- `explore(query)`에서 문서/코드 후보를 함께 수집하고 결과를 통합 반환
- 기본 `view=auto`에서 preview/section 중심으로 제공
- `explore(paths, view=full)`에서 원문 읽기 지원(상한/잘림 표준화)

### Phase 2 — Evidence Packs & Progressive Disclosure

- packId/cursor를 `explore`의 표준 경로로 고정
- 중복 열람 최소화(같은 packId 요청 시 동일 preview/section 재사용)

### Phase 3 — 레거시 정리/문서화/테스트 강화

- `navigate`/`read` 관련 문서/테스트/가이드 정리
- Hard cut 또는 Soft window 전략 확정 및 반영

---

## 7. Testing Plan

### 7.1 Unit Tests

- `explore` routing:
  - query-only: docs+code 혼합 결과가 나오고, preview가 기본으로 채워짐
  - paths+full: 원문 읽기 동작 + maxBytes/maxChars 적용
  - packId reuse: 동일 packId로 중복 응답이 줄어드는지(ADR-038)

### 7.2 Integration Tests

- MCP tool listing에서 외부 도구가 5개만 노출되는지
- “문서 확장” 포맷(.md/.mdx/.txt/.log/.docx/.xlsx/.pdf)이 explore에서 일관되게 열람 가능한지

---

## 8. Consequences

### Positive

- 사용자 인지 부하 감소: “찾기/읽기”가 하나로 합쳐져 도구 사용이 직관적
- 토큰/시간 효율: evidence pack + preview/section 기본값으로 중복 열람 감소
- 문서 확장(ADR-036~039) 효과가 외부 UX에 자연스럽게 반영됨

### Negative / Risks

- 스키마가 커짐: `explore`는 multi-intent 도구이므로 입력/출력 스펙 관리가 중요
- 잘못 설계하면 full read가 남발되어 토큰 폭발이 재발할 수 있음 → 기본값/상한/packId가 필수
- 레거시 클라이언트 설정 깨짐 → migration 가이드/토글 전략 필요

---

## 9. Success Metrics

- 외부 toolset이 5개로 줄어들고, 실제 사용 시 `navigate→read` 왕복이 `explore` 1~2회로 대체됨
- 동일 주제 반복 호출에서 packId 재사용으로 토큰/응답 시간이 눈에 띄게 감소
- 문서/코드 혼합 탐색에서 “preview/section 중심 + 필요 시 full”이 안정적으로 동작

---

## 10. Open Questions

- `explore`의 directory 확장 규칙(soft priority 비율/선호 확장자 목록)을 어디까지 고정할지(초기엔 `depth=5`, 20% 보정 권장)
