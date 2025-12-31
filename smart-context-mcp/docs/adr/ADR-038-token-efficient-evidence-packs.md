# ADR-038: Token-Efficient Evidence Packs & Progressive Disclosure (Agent Token Budget)

**Status:** Proposed  
**Date:** 2025-12-31  
**Author:** Architecture Team  
**Related ADRs:** ADR-033 (Six Pillars), ADR-034/035 (Budgets & Degradation), ADR-022 (SQLite/WAL), ADR-036 (Universal Document Support), ADR-037 (Docs v2: Plain text + Evidence Contract + Embedding Ops + Storage v4)

---

## 1. Executive Summary

ADR-036/037을 통해 smart-context-mcp는 문서/텍스트/주석까지 “근거 중심”으로 검색(`doc_search`)하고, 필요 시 섹션 단위로 읽을 수 있게(`doc_section`) 되었습니다.  
하지만 실제 운영에서 **에이전트 컨텍스트(토큰)가 과도하게 소비**되는 문제가 빠르게 나타납니다.

- `doc_search`가 충분한 근거를 제공하려고 할수록, 응답 payload(미리보기/근거 섹션)가 커짐
- Six Pillars(`understand/change/navigate/read/...`)가 이 근거들을 응답에 포함시키면서 “도움 되는 정보”와 “토큰 낭비”의 경계가 흐려짐
- 토큰을 줄이기 위해 근거를 줄이면, 에이전트가 다시 `doc_*`를 호출하면서 **중복 열람/중복 계산**이 증가할 수 있음

본 ADR-038은 이 트레이드오프를 해결하기 위해 다음을 도입합니다.

1) **Progressive Disclosure**: 기본 응답은 “짧고 단단한 메타 + 최소 프리뷰”만 제공하고, 확장이 필요할 때만 특정 섹션을 펼친다.  
2) **Evidence Pack**: `doc_search` 결과를 **packId로 묶어 재사용**(중복 호출 방지)하고, staleness/TTL/프루닝을 계약으로 고정한다.  
3) **Section Summary Cache**: “원문을 보내지 않고도” 답을 구성할 수 있도록 섹션 요약/압축 프리뷰를 서버가 생성·저장·재사용한다(LLM 의존 없이, deterministic/extractive 기반).

목표는 “검색 품질 개선”이 아니라 **토큰 효율과 반복 호출 효율**입니다.

---

## 2. Problem Statement

### 2.1 현상

- 문서/텍스트/주석 커버리지가 확장되며 `doc_search`의 후보/결과/근거가 증가한다.
- 특히 CHANGE/UNDERSTAND에서 “근거를 더 많이” 제공하는 정책(ADR-037)이 유지될수록 응답 크기가 커진다.
- 결과적으로:
  - 에이전트가 실제 변경 작업을 시작하기 전에 컨텍스트가 소진되거나,
  - 중요한 정보가 컨텍스트 후반에서 잘려 오히려 품질이 떨어지며,
  - 토큰을 줄이려 근거를 줄이면 에이전트가 재호출하여 중복 비용이 발생한다.

### 2.2 근본 원인

- 현재 계약은 “근거를 많이”에 최적화되어 있고, “근거를 짧게 + 재사용”을 위한 **ID/캐시/요약/패키징**이 부족하다.
- 에이전트가 같은 쿼리/근거를 반복 접근할 때:
  - 서버는 동일한 계산(검색/정렬/요약)을 반복하거나,
  - 동일한 섹션 원문을 반복 전송하게 된다.

---

## 3. Goals / Non-Goals

### Goals

- **토큰 예산 안에서** 결과/근거를 “가능한 만큼” 제공하되, 기본 응답은 **짧게** 유지한다.
- 동일한 쿼리/후속 질문에서 **중복 열람/중복 전송**을 줄인다.
- “근거 투명성”(출처/섹션/라인/종류 kind)을 유지하면서도 **요약/압축**을 1차 산출물로 만든다.
- LLM 의존 없이(네트워크/비용/재현성 문제) 기본 요약이 동작하도록 한다.
- Six Pillars 내부에서 자연스럽게 적용되도록 기본값/정책을 통합한다.

### Non-Goals

- 검색 알고리즘을 최신으로 교체(SPLADE/ColBERT/ANN/HNSW/ScaNN/FAISS)하는 것 자체가 목표가 아니다.
- cross-encoder rerank를 기본 경로로 넣지 않는다(옵션으로 별도 ADR에서 검토).
- “모든 도구”에 대해 완벽한 토큰 카운팅을 구현하지 않는다(1차는 chars 기반 근사치).

---

## 4. Decision (High-level)

### 4.1 기본 전략: “짧게 + 확장 가능 + 재사용”

- `doc_search`는 기본적으로 **compact** 모드(메타 + 짧은 프리뷰 + packId)로 동작한다.
- `doc_section`은 특정 섹션만 펼치되, 기본은 **summary/preview**로 제공한다.
- 동일한 결과 집합은 `packId`로 재사용하여 중복 호출을 “재전송/재사용”으로 바꾼다.

### 4.2 Evidence Pack 도입

- `doc_search`의 산출물은 `packId`로 식별되는 **Evidence Pack**으로 저장/캐시된다.
- Pack은 다음을 포함한다:
  - top results(섹션 메타)
  - evidence candidates(근거 묶음 후보)
  - 각 항목의 “압축 프리뷰”(원문 아님)
  - budget 사용량(섹션 수/문자 수/트렁케이션 여부)
  - staleness 검증을 위한 snapshot(content_hash 등)

### 4.3 Section Summary Cache

- 원문을 매번 전송하는 대신, chunk/section 단위로 “요약/압축 프리뷰”를 생성하고 저장한다.
- 기본 요약은 deterministic/extractive:
  - heading/키워드 포함 문장/불릿/주의 문장 기반 상위 K 라인
  - 코드 주석은 leading lines + tag(@param/@returns 등) 중심
- LLM 요약은 기본 비활성(옵션/추후 ADR로).

---

## 5. Type System (Contracts)

### 5.1 Section Reference (stable)

```ts
export interface DocSectionRef {
  filePath: string;
  kind: "markdown" | "mdx" | "html" | "css" | "text" | "code_comment" | "unknown";
  sectionId: string;         // DocumentSection.id (stable)
  headingPath?: string[];    // optional for humans
  range?: { startLine: number; endLine: number };
}
```

### 5.2 Evidence Pack Contract

```ts
export type EvidenceRole = "result" | "evidence";

export interface EvidencePackMeta {
  packId: string;                 // stable id (hash)
  createdAt: number;              // epoch ms
  expiresAt?: number;             // TTL
  hit: boolean;                   // cache hit (optional)
  stale?: boolean;                // snapshot mismatch detected
}

export interface EvidenceItem {
  role: EvidenceRole;
  rank: number;                   // 1..N
  ref: DocSectionRef;
  preview: string;                // compact/extractive preview
  scores?: { bm25: number; vector?: number; final: number };
  snapshot?: { contentHash?: string; updatedAt?: number };
}

export interface EvidenceBudgetUsage {
  maxEvidenceSections: number;
  maxEvidenceChars: number;
  usedEvidenceSections: number;
  usedEvidenceChars: number;
  evidenceTruncated: boolean;
  approxTokens?: number;          // rough estimate (chars/4)
}
```

### 5.3 API shape changes (internal)

> `doc_*`는 내부 도구이므로 “표면 도구 수”가 늘지 않아도 된다. 다만 Six Pillars가 내부 호출하는 응답 계약은 고정되어야 한다.

`doc_search` input 확장(예시):

```ts
export interface DocSearchArgsV2 {
  query: string;
  output?: "compact" | "full" | "pack_only"; // default: compact (Six Pillars)
  packId?: string;                           // when provided: reuse if valid
  includeEvidence?: boolean;                 // default true, but compact는 caps가 작음
  includeScores?: boolean;                   // default false in compact
  snippetLength?: number;                    // compact default smaller
  maxEvidenceSections?: number;
  maxEvidenceChars?: number;
}
```

`doc_search` response 확장(예시):

```ts
export interface DocSearchResponseV2 {
  query: string;
  pack: EvidencePackMeta;
  results: EvidenceItem[];     // role="result" only
  evidence?: EvidenceItem[];   // role="evidence" only (optional)
  budget: EvidenceBudgetUsage;
  degraded?: boolean;
  reason?: string;
  reasons?: string[];
}
```

`doc_section` input 확장(예시):

```ts
export interface DocSectionArgsV2 {
  filePath: string;
  sectionId?: string;
  headingPath?: string[] | string;
  mode?: "summary" | "preview" | "raw"; // default: preview
  maxChars?: number;                   // hard cap (raw에도 적용)
  packId?: string;                     // optional: hint for cache reuse
}
```

---

## 6. Storage (Schema v5 proposal)

> ADR-037 WS-D로 schema v4까지 확장되었다. ADR-038은 “token 효율”을 위해 pack/summary 저장을 추가로 요구하므로 schema v5가 자연스럽다.

### 6.1 Tables

```sql
CREATE TABLE IF NOT EXISTS evidence_packs (
  pack_id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  degraded_json TEXT,
  root_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS evidence_pack_items (
  pack_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('result','evidence')),
  rank INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  section_id TEXT NOT NULL,
  heading_path_json TEXT,
  start_line INTEGER,
  end_line INTEGER,
  preview TEXT NOT NULL,
  content_hash_snapshot TEXT,
  updated_at_snapshot INTEGER,
  scores_json TEXT,
  PRIMARY KEY(pack_id, role, rank),
  FOREIGN KEY(pack_id) REFERENCES evidence_packs(pack_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evidence_pack_items_chunk ON evidence_pack_items(chunk_id);
CREATE INDEX IF NOT EXISTS idx_evidence_pack_items_file ON evidence_pack_items(file_path);

CREATE TABLE IF NOT EXISTS chunk_summaries (
  chunk_id TEXT NOT NULL,
  style TEXT NOT NULL, -- 'summary' | 'preview'
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(chunk_id, style)
);
```

### 6.2 Pruning / TTL

- `evidence_packs.expires_at` 기반으로 TTL 프루닝(예: 24h) 트리거/주기 작업을 제공한다.
- `chunk_summaries`는 content_hash 변경 시 무효화(soft)하거나, lazy 재생성.

---

## 7. Algorithm: Summarize/Preview (deterministic)

### 7.1 Preview 생성(기본)

- 목적: “섹션 원문을 보내지 않고도” 에이전트가 판단 가능하도록 핵심 라인만 제공
- 기본 규칙(예시):
  - heading/불릿/주의(Warning/Caution/Note)/명령형 문장 우선
  - 쿼리 토큰 포함 문장 우선
  - 최대 K 라인 또는 maxChars 내로 자름
  - normalize(공백/연속 빈줄 정리), line count 유지 필요 없음(원문은 doc_section에서)

### 7.2 요약 생성(옵션)

- preview보다 더 짧은 요약이 필요하면:
  - “이 섹션이 말하는 핵심 3개”를 rule-based로 생성(예: bullet 3개)
  - 기본은 extractive(문장 선택)로 유지

---

## 8. Six Pillars Integration (token-aware defaults)

> 핵심: Pillars는 `doc_search`를 “결과+근거 원문”으로 받아서 그대로 출력하지 않고, **pack 기반으로 최소 정보만 노출**한다.

### 8.1 CHANGE

- 기본:
  - 관련 문서 추천은 `DocSectionRef[]` + preview 1~2개만 포함
  - 더 많은 근거는 `packId`로 연결(후속 질문에서 확장)
- 정책:
  - 동일한 변경 작업 중 같은 packId는 재사용
  - 문서 추천이 길어질수록 “원문 첨부” 대신 “추가 후보 리스트”로 대체

### 8.2 UNDERSTAND / NAVIGATE

- 이해/탐색 단계에서는 compact `doc_search`를 기본으로 사용
- 사용자가 “해당 문서/섹션 전문 보여줘”를 요청할 때만 `doc_section(mode=raw)`로 확장

### 8.3 Configuration (env knobs)

> 기본값은 “토큰 효율(짧게)”에 맞춰져 있고, 필요 시 점진적으로 확장할 수 있도록 한다.

| Env | Default | Purpose |
| --- | --- | --- |
| `SMART_CONTEXT_EVIDENCE_PACK_CACHE_SIZE` | `100` | in-memory evidence pack LRU 크기 |
| `SMART_CONTEXT_EVIDENCE_PACK_TTL_MS` | `86400000` (24h) | evidence pack TTL(만료/프루닝 기준) |
| `SMART_CONTEXT_ATTACH_DOC_SECTIONS` | `false` | CHANGE 등에서 `doc_section` 원문/요약을 “응답에 자동 첨부”할지 여부 |
| `SMART_CONTEXT_ATTACH_DOC_SECTIONS_MAX` | `0` | 자동 첨부 시 최대 섹션 수(0이면 비활성) |
| `SMART_CONTEXT_DOC_SNIPPET_MAX_CHARS` | `1200` | NAVIGATE 등에서 문서 스니펫 hard cap |
| `SMART_CONTEXT_DOC_SKELETON_MAX_CHARS` | `2000` | READ에서 문서 skeleton hard cap |

---

## 9. Implementation Plan (4 Phases)

### Phase 1 — Contracts + In-memory Packs

- `doc_search`에 `output=compact|full|pack_only` 추가, compact 기본값 적용(내부)
- `packId` 생성/반환, in-memory LRU cache로 재사용
- caps 기본값 재조정(짧은 snippetLength, 작은 maxEvidenceChars)
- 테스트: 동일 query에 pack hit로 동일 packId 재사용

### Phase 2 — Storage v5 (Packs + Summaries)

- schema v5 마이그레이션 추가(evidence_packs/evidence_pack_items/chunk_summaries)
- TTL 프루닝 구현
- pack staleness snapshot(문서 chunk content_hash) 저장/검증

### Phase 3 — Deterministic Summarizer

- preview/summary 생성기 구현(언어 불문 텍스트)
- `chunk_summaries`에 저장/재사용
- degraded reasons 추가:
  - `pack_stale`, `pack_expired`, `summary_missing`, `summary_truncated`

### Phase 4 — Pillar defaults (Token-aware)

- Orchestration에서 doc 관련 호출을 compact 기본으로 전환
- 응답 포맷에서 “원문 첨부”를 최소화하고 sectionRef/packId 중심으로 전환
- Success metrics 수집(응답 크기/호출 횟수/latency)

---

## 10. Risks / Mitigations

- **중복 호출 증가**(근거를 줄인 대가)  
  → packId 재사용 + summary cache + “확장 가이드(sectionId 리스트)”로 검색 재실행을 방지

- **팩 스테일(stale)**  
  → snapshot(content_hash) + TTL + degraded reason 노출

- **DB 비대화(팩/요약 저장)**  
  → TTL 프루닝 + max rows cap + opt-in summary 저장

- **품질 저하(요약/프리뷰가 오해 유발)**  
  → summary는 “근거 요약”일 뿐 “정답”이 아님을 계약에 명시, 필요 시 raw 확장 경로 제공

---

## 11. Success Metrics

- CHANGE/UNDERSTAND 응답의 평균 payload(문자 기준) 30~60% 감소
- 동일 작업 흐름에서 `doc_search` 반복 호출 횟수 감소(pack reuse로 재활용)
- `doc_section(mode=raw)` 호출 비율이 “필요할 때만” 증가(무분별한 원문 전송 감소)
- degraded reason을 통해 “왜 짧아졌는지/왜 잘렸는지” 설명 가능
