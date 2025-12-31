# ADR-037: Universal Text + Code Comments + Retrieval Quality + Embedding Ops + Scalable Storage (Docs v2)

**Status:** Proposed  
**Date:** 2025-12-31  
**Author:** Architecture Team  
**Related ADRs:** ADR-033 (Six Pillars), ADR-022 (SQLite/WAL), ADR-034/035 (Budgets & Degradation), ADR-036 (Universal Document Support: Markdown/MDX-first)

---

## 1. Executive Summary

ADR-036을 통해 smart-context-mcp는 `.md/.mdx` 문서를 **구조적으로 읽고(TOC/Section/Skeleton)**, **하이브리드 검색(BM25 + Vector + RRF + MMR)** 하며, **문서→코드 연결(doc_references / mentions)** 및 **change→문서 추천**까지 기본 사용이 가능해졌습니다.

하지만 “현업 프로젝트” 기준으로 아직 5가지 공백이 남습니다.

1) **범용 텍스트(Plain Text) 지원**: `.txt`, `LICENSE`, `.env`, `.gitignore`, `CHANGELOG` 등 “마크다운이 아닌 텍스트”도 실질적으로 중요한 근거이며, 문서 파이프라인으로 편입되어야 합니다.  
2) **코드 주석(Code Comments) 지원**: 코드 주석(JSDoc/docstring/leading comment)은 설계 의도/제약/주의사항이 남는 “사람이 작성한 근거”입니다. 이를 문서와 동일한 retrieval 모델로 취급하면 코드-문서 간 간극을 줄일 수 있습니다.  
3) **검색 품질/근거 계약(Evidence Contract) 고도화**: rerank 없이도(=비용/지연 최소화) 신뢰 가능한 답을 위해 “근거 반환 방식”과 “degraded 사유”를 계약으로 고정하고, 평가/튜닝 루프를 마련해야 합니다.  
4) **임베딩 운영(Embedding Ops)**: 로컬 임베딩(@xenova/transformers) 기반을 “그냥 돌아감”에서 “예측 가능/안정적/제어 가능”으로 올려야 합니다(캐시, 워밍업, 동시성, 타임아웃, 백그라운드 부하분산).  
5) **저장소/인덱스 스케일(Scalable Storage)**: 문서/청크/임베딩이 누적될수록 DB가 커지고 검색이 느려지므로, 스키마/인덱스/프루닝/마이그레이션 전략이 필요합니다.

본 ADR-037은 위 5개를 **하나의 “Docs v2” 로드맵**으로 묶어, 실제 구현이 가능한 수준의 설계(타입/스키마/컴포넌트/테스트/단계별 계획)를 정의합니다.

---

## 2. Problem Statement

### 2.1 현재(ADR-036 이후) 상태 요약

- `.md/.mdx`는 문서 인덱싱/검색/섹션 읽기/링크 분류가 동작한다.
- `doc_search`는 BM25 + Vector를 RRF로 결합하고, 기본적으로 MMR(다양성)을 적용한다.
- 로컬 임베딩은 `@xenova/transformers`로 자동 폴백이 가능하나, 모델 다운로드/캐시/부하 분산은 운영 관점에서 불투명하다.
- 문서 관련 도구(`doc_*`)는 기본적으로 “내부 도구”이며, Six Pillars에서 내부 호출로 사용된다.

### 2.2 공백

- **Plain text**: heading이 없는 텍스트 파일은 TOC/Section 단위로 다루기 어렵고, fixed chunk/overlap + heuristic outline이 필요하다.
- **Quality/Evidence**: “rerank 생략 + 근거 섹션을 더 많이 반환” 정책을 시스템 계약으로 만들고, 평가 지표와 튜닝 레버를 명확히 해야 한다.
- **Embedding Ops**: 최초 호출 시 모델 다운로드로 지연/타임아웃이 발생할 수 있고, 동시 임베딩 요청이 집중되면 CPU/RAM 스파이크가 난다.
- **Storage**: 단일 `chunk_embeddings` PK 설계/인덱스 부족/프루닝 부재로 확장 시 병목이 생긴다.

---

## 3. Goals / Non-Goals

### Goals

- `.md/.mdx` 뿐 아니라 **Plain text 문서**도 `doc_*` 파이프라인(TOC/Section/Skeleton/Search/References)로 처리한다.
- **코드 주석(JSDoc/docstring/leading comments)** 을 “사람이 작성한 근거”로 취급하여 문서 검색/근거 모델에 포함한다.
- rerank 없이도 신뢰 가능한 결과를 위해 **Evidence Contract(근거/투명성/Degraded 사유/동적 반환)** 를 표준화한다.
- 로컬 임베딩을 **캐시/워밍업/동시성/타임아웃/부하분산** 관점에서 운영 가능하게 만든다.
- SQLite 기반 저장소를 **스키마/인덱스/프루닝/마이그레이션**까지 포함해 확장 가능하게 만든다.
- Six Pillars(`understand/change/navigate/read/...`)에서 문서 기능이 자연스럽게 작동하도록 통합한다.

### Non-Goals

- 즉시 PDF/Word/HTML의 범용 지원(ADR-038+에서 검토).
- cross-encoder/LLM rerank를 기본 경로로 도입(옵션으로만 검토).
- ANN 라이브러리 도입을 전제로 한 대규모 벡터 검색(초기엔 TopK 후보 제한 + 선형 스캔 유지).

---

## 4. Decision (High-level)

### 4.1 DocumentKind 확장: Markdown/MDX + Text

- 기존 `DocumentKind = "markdown" | "mdx" | "text" | "unknown"`을 유지한다.
- “코드 주석”은 문서/텍스트와 성격이 다르므로 **`DocumentKind="code_comment"`** 로 분리하는 것을 권장한다.
  - 이유: 검색 결과에서 출처를 명확히 구분(투명성)하고, 가중치/필터/캡 정책을 독립적으로 튜닝하기 위함.
  - 구현 부담을 줄이려면, 우선 `document_chunks.kind`에 `"code_comment"` 값을 저장하고(스키마는 TEXT), 타입/응답 계약은 점진적으로 확장한다.
- `DocumentIndexer`가 지원하는 확장자는 “안전한 기본값 + 옵션 확장”으로 정의한다.
  - 기본(always): `.md`, `.mdx`, 그리고 well-known 텍스트 파일(확장자 없음 포함)
  - 옵션(opt-in): `.txt`, `.env`, `.ini`, `.conf`, `.cfg`, `.properties`, `.log` 등은 크기/샘플링 가드와 함께 활성화

### 4.2 Parsing/Profiling 전략

- Markdown/MDX: ADR-036과 동일(remark 유지, `.md`는 tree-sitter 가능 시 더 정확한 heading 경계)
- Text: “정확한 AST” 대신 **Heuristic Outline + Fixed/Sliding Window Chunking** 를 1차 목표로 한다.

### 4.3 Retrieval 품질 전략 (rerank 생략)

- rerank는 기본 비활성(=비용/지연 절감), 대신:
  - 후보 축소(TopK) + RRF 결합
  - MMR 기본 ON(중복/편향 완화)
  - “근거 섹션”을 가능한 한 많이 반환(단, 최대치/예산 내)
- 결과는 “답”이 아니라 “근거”를 제공하며, **출처 다양성/정합성/불일치**를 드러낸다(투명성).

### 4.4 Embedding Ops

- provider=auto 기본 유지(OpenAI 가능하면 우선, 아니면 local, 아니면 disabled).
- 로컬 임베딩은:
  - 캐시 위치/용량/퍼미션을 명시적으로 제어
  - 워밍업(사전 다운로드) 지원
  - 동시성 제한 + 요청당 시간 예산(타임아웃) 적용
  - 백그라운드 점진적 임베딩(부하 분산)을 옵션으로 제공

### 4.5 Storage/Schema v4

- SQLite(IndexDatabase) 확장(마이그레이션 v4)로:
  - `chunk_embeddings`를 (chunk_id, provider, model) 복합키로 확장(다중 모델/전환 안전)
  - 대량 검색을 위한 인덱스 보강
  - 프루닝/유지 정책을 저장소 레벨에서 제공

---

## 5. Type System (추가/확장)

### 5.1 Text profiling/sections

```ts
export type TextHeadingStyle =
  | "markdown_like"      // e.g. "## Title"
  | "underline"          // e.g. "Title\n====="
  | "all_caps"           // e.g. "CONFIGURATION"
  | "numbered"           // e.g. "1. Title", "1) Title"
  | "separator"          // e.g. "-----"
  | "none";

export interface TextOutlineHeuristics {
  maxDepth?: number;            // depth for inferred headings (default: 3)
  minHeadingChars?: number;     // default: 3
  maxHeadingChars?: number;     // default: 80
  allowAllCaps?: boolean;       // default: true
  allowNumbered?: boolean;      // default: true
  allowUnderline?: boolean;     // default: true
}

export interface DocumentIndexingLimits {
  maxFileBytes?: number;        // default: 2_000_000 (2MB)
  maxLines?: number;            // default: 50_000
  sampleStrategy?: "none" | "head_tail";   // default: head_tail
  headBytes?: number;           // default: 600_000
  tailBytes?: number;           // default: 300_000
}
```

### 5.2 Code Comment Types (new)

```ts
export type CodeCommentKind =
  | "jsdoc"            // /** ... */
  | "leading_block"    // /* ... */ above decl
  | "line"             // // ... or # ...
  | "docstring"        // Python triple-quote
  | "unknown";

export interface CodeCommentChunkMeta {
  sourceFilePath: string;       // 실제 코드 파일 경로
  language: string | null;      // ts/py/...
  symbolPath?: string[];        // ["Class", "method"] 등
  symbolName?: string;          // leaf
  commentKind: CodeCommentKind;
  extractedBy: "tree-sitter" | "regex";
}
```

### 5.3 Retrieval/Evidence Contract

```ts
export type DegradationReason =
  | "parser_fallback"
  | "closest_match"
  | "vector_disabled"
  | "embedding_timeout"
  | "embedding_partial"
  | "evidence_truncated"
  | "budget_exceeded"
  | "sampling_applied";

export interface EvidenceBudget {
  maxEvidenceSections: number;  // hard cap
  maxEvidenceChars: number;     // hard cap
  targetEvidenceChars?: number; // soft target (dynamic fill)
}

export interface DocSearchContract {
  results: "top_sections";
  evidence: "max_fill_under_caps";
  transparency: {
    includeScores: boolean;
    includeProvider: boolean;
    includeDegradation: boolean;
  };
}
```

> **Note**: 코드 주석까지 검색 범위에 포함되는 경우, 각 결과/근거 섹션은 `kind`(예: `"code_comment"`)를 포함하여 “출처 투명성”을 보장해야 한다.

---

## 6. Plain Text Support (Docs v2)

### 6.1 지원 대상(기본 + 옵션)

**기본(always)**
- `.md`, `.mdx` (ADR-036 유지)
- well-known 텍스트 파일(확장자 없는 파일 포함):
  - `README`, `README.*`, `LICENSE`, `NOTICE`, `CHANGELOG`, `CODEOWNERS`, `.gitignore`, `.mcpignore`, `.editorconfig`

**옵션(opt-in)**
- `.txt`, `.env`, `.ini`, `.conf`, `.cfg`, `.properties`, `.log`
- `.css` (1차: text 취급만)
- `.html` (1차: text 추출, 2차: 구조 파싱)

> 정책: “문서가 수백/수천 수준”이라면 이득이 크고, “수만+ 로그”는 비용/노이즈가 커서 opt-in + size cap + 샘플링으로 관리한다.

### 6.2 Text 프로파일링: Heuristic Outline

**핵심 아이디어**
- heading이 없는 텍스트는 TOC를 “추정”한다.
- 추정 실패 시에도 최소한 `fixed window chunking`으로 `doc_section`/`doc_search`는 동작해야 한다.

**Heuristic 후보(우선순위)**
1) Markdown-like: `^#{1,6}\s+...`  
2) Underline style:
   - `Title` 다음 줄이 `=====`(H1) 또는 `-----`(H2)  
3) Numbered: `^\d+[\.\)]\s+Title`  
4) ALL CAPS line(짧고 공백 비율 낮음)  
5) Separator line(섹션 분리 신호)

### 6.3 Text Chunking: Sliding Window (+ overlap)

Text는 구조 기반 chunking이 약하므로 다음을 기본으로 한다.

- `targetChunkChars`: 1200~2000
- `overlapChars`: 200~300
- 줄 경계 우선(가능한 경우 문장/문단 경계)

의사코드:

```ts
for each file:
  content = applySamplingIfNeeded(content, limits)
  boundaries = inferTextHeadings(content) // may be empty
  if boundaries not empty:
    chunks = chunkByInferredSections(boundaries)
  else:
    chunks = chunkByWindow(content, targetChunkChars, overlapChars)
```

### 6.4 Code Comments as Universal Text

ADR-037의 “Universal Text” 범위에는 **코드 파일의 주석(문서화 주석)** 도 포함한다.

**왜 포함하나**
- 설계 의도/제약/주의사항은 `README`보다 코드 주석(JSDoc/docstring)에 더 자주 남는다.
- 에이전트가 “문서 기반 근거”를 만들 때, 코드 주석은 문서와 동일한 가치의 근거가 될 수 있다.

**원칙**
- 주석은 “문서”처럼 검색되되, 코드 본문과 섞이지 않도록 `kind="code_comment"`로 분리한다.
- 기본은 low-noise(문서화 주석 중심)이며, line comment는 옵션으로 제한적으로 포함한다.

**1차 범위(추천, low-noise)**
- JS/TS: declaration 바로 위의 block comment/JSDoc (`/** ... */`, `/* ... */` leading)
- Python: 함수/클래스의 docstring

**2차 범위(옵션)**
- line comment(`//`, `#`)는 “길이/키워드/패턴(예: NOTE/WARN/TODO/IMPORTANT)” 기반으로만 포함

**Extraction 전략(재사용 우선)**
- tree-sitter 기반 추출을 1순위로 사용(이미 존재하는 `DocumentationExtractor` 로직 재사용/확장).
- tree-sitter가 없거나 언어 미지원이면 regex 폴백(최소 기능).

**Indexing 모델(권장)**
- code indexing 시점(IncrementalIndexer 처리)에서:
  - code file → comment chunks 생성/업서트
  - `document_chunks.kind="code_comment"`
  - `section_path_json`: symbol path(예: `["Class","method"]`)
  - `heading`: symbolName 또는 comment title(가능하면)

**Search 모델(권장)**
- `doc_search` 기본 대상: `.md/.mdx/.text`
- 아래 조건이면 코드 주석도 포함:
  - 쿼리에 symbol hint가 있거나(예: `FooService`, `Class.method`)
  - 또는 `includeComments=true` 옵션이 켜짐

**Degradation**
- 주석 추출이 제한되거나 폴백이면 `degraded=true` + `reason=["parser_fallback"]` 등으로 투명하게 표시한다.

### 6.5 HTML/CSS Support (CSS=1차, HTML=2차까지)

**왜 포함하나**
- HTML/CSS는 “문서”라기보다 UI/템플릿이지만, 실제 프로젝트에서는 요구사항/UX/설명 텍스트가 HTML에 직접 포함되는 경우가 있다.
- CSS는 naming convention(BEM/utility class)과 디자인 토큰이 중요한 근거가 될 수 있다.

#### 6.5.1 CSS (1차까지만)

- 목표: 구조 파서 없이도 검색/근거 제공이 가능해야 한다.
- 전략:
  - `DocumentKind="text"`로 취급(=tag parsing 없음).
  - chunking은 `sliding window + overlap`을 기본으로 한다.
  - (옵션) `}`/blank line 기준으로 “대략적인 블록 경계”를 유지해 chunk 품질을 개선할 수 있으나, AST 수준의 정확성을 목표로 하지 않는다.
- 주의:
  - `.min.css`, 번들 산출물(예: `*.bundle.css`)은 기본 ignore/size cap/sampling로 강하게 제한한다.

#### 6.5.2 HTML (1차 + 2차)

**1차(빠른 도입, text 추출)**
- 목표: HTML을 “보이는 텍스트 + 링크” 중심으로 텍스트 코퍼스에 편입.
- 전략:
  - tag를 제거하여 visible text만 남기는 `HtmlTextExtractor`를 도입(최소: regex 기반, 가능하면 parse5/rehype 기반).
  - 링크/리소스(`href/src`)는 best-effort로 추출하여 `doc_references` 계약에 포함(또는 별도 `references` 배열로 제공).
  - chunking은 text와 동일하게 window 기반.
- Degradation:
  - “tag strip” 폴백을 사용하면 `degraded=true`, `reason=["parser_fallback"]`로 표시한다.

**2차(정확도, 구조 파싱)**
- 목표: “문서처럼” 섹션/링크/구조를 안정적으로 추출.
- 전략(권장):
  - `tree-sitter-html` WASM을 사용하여:
    - `<h1..h6>`를 section boundary로 사용
    - `<a href>`, `<img src>`, `<link href>`, `<script src>` 등을 구조적으로 추출
  - 빌드/배포는 ADR-036의 markdown wasm과 동일한 운영 모델을 따른다(프로젝트 내 `wasm/`에 사전 배치, 런타임은 로컬 경로만).
- 폴백:
  - WASM 로딩 실패 시 1차(text 추출)로 폴백(그리고 degraded 표시).

---

## 7. Retrieval Quality & Evidence Contract (No-rerank Default)

### 7.1 기본 정책(합의 반영)

- rerank: 생략(기본)
- 근거: “맥시멈(상한)을 정해놓고, 그 안에서 가능한 만큼 반환”(동적 fill)
- MMR(다양성): 기본 ON

### 7.2 Evidence Contract (API/응답 표준)

`doc_search`는 다음을 만족한다.

1) `results`: TopK 섹션(“답 후보”)  
2) `evidence`: 결과를 뒷받침하는 추가 섹션(“근거 묶음”)  
3) `degraded`: 근거가 잘렸거나/벡터가 비활성화/타임아웃 등 품질 저하가 있으면 true  
4) `reason[]`: 왜 degraded인지(예: embedding_timeout, evidence_truncated)

**동적 fill 규칙**
- `maxEvidenceSections`, `maxEvidenceChars`를 hard cap으로 두고
- 그 안에서 “가능한 한 많이” 채운다(=근거 폭 증가)

### 7.3 평가/튜닝 루프(최소 단위)

- Golden set(소규모): 프로젝트 내 실제 질문 30~100개
- 메트릭:
  - Precision@K (TopK 섹션이 답을 포함하는 비율)
  - Evidence coverage(근거가 다양하게 분포하는지: 문서/섹션 분산)
  - Latency p50/p95
- 튜닝 레버:
  - 후보 제한(`maxCandidates/maxChunkCandidates/maxVectorCandidates`)
  - RRF depth/k
  - MMR lambda
  - snippet/evidence caps

---

## 8. Embedding Ops (Local-first Reliability)

### 8.1 캐시/워밍업/퍼미션

로컬 모델은 첫 호출에서 다운로드가 발생할 수 있으므로 다음을 제공한다.

- `SMART_CONTEXT_MODEL_CACHE_DIR` (권장): 모델/토크나이저 캐시 루트
  - 서버 시작 시, 설정되어 있으면 `XDG_CACHE_HOME` / `TRANSFORMERS_CACHE` 등으로 브릿지
- 워밍업 CLI:
  - `smart-context-warmup-embeddings --model Xenova/all-MiniLM-L6-v2`
  - 목적: “다운로드 + 1회 더미 임베딩”으로 런타임 타임아웃 방지

### 8.2 동시성/타임아웃/부하 분산

- 동시성 제한:
  - `SMART_CONTEXT_EMBEDDING_MAX_CONCURRENCY` (default: 1~2)
  - `SMART_CONTEXT_EMBEDDING_QUEUE_MAX` (default: 64)
- 요청 예산:
  - `SMART_CONTEXT_EMBEDDING_TIMEOUT_MS` (default: 2500~5000)
- 백그라운드 점진 임베딩:
  - idle 시간/배치 크기를 이용해 chunk를 천천히 채움(옵션)
  - `SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER=true`는 “전체 eager”이므로,
    - ADR-037에서는 “progressive eager” 모드(`SMART_CONTEXT_DOCS_EMBEDDINGS_PROGRESSIVE=true`)를 추가 검토한다.

---

## 9. Scalable Storage (SQLite Schema v4)

### 9.1 문제: 단일 PK(`chunk_id`)의 한계

현재 `chunk_embeddings`가 `chunk_id` 단일 PK이면:
- provider/model 전환 시 overwrite가 발생하고
- 동일 chunk에 대해 다중 모델 공존/비교가 어렵다.

### 9.2 v4 스키마 제안

1) `chunk_embeddings`를 복합키로 확장:

```sql
CREATE TABLE IF NOT EXISTS chunk_embeddings_v2 (
  chunk_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  norm REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, provider, model),
  FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_v2_model
  ON chunk_embeddings_v2(provider, model, created_at DESC);
```

2) 프루닝 정책(옵션)
- provider/model별로 “최신 N개 chunk만 유지” 또는 “created_at 기준 TTL”
- 관리 명령: `manage(command="rebuild")`와 별개로 `manage(command="prune")`(추가 검토)

3) 마이그레이션 전략
- 기존 `chunk_embeddings` → `chunk_embeddings_v2`로 이관 후 rename
- 대규모 DB에서도 안전하게(트랜잭션 + 배치)

---

## 10. Six Pillars 통합(Phase 4+ 강화)

### 10.1 UNDERSTAND

- 문서 파일이면:
  - `doc_analyze`로 skeleton/outline/links/mentions 확보
  - `mentions`는 `search_project`로 교차 검증하여 `relatedCode`로 제공

### 10.2 NAVIGATE

- `context="docs"`:
  - path가 명시되면 `doc_skeleton + doc_toc + doc_references`
  - 질의면 `doc_search`로 섹션 중심 결과 제공

### 10.3 CHANGE

- 코드 변경 시:
  - `doc_search`로 관련 문서 후보를 찾고
  - 상위 N개는 `doc_section`으로 근거를 직접 첨부(`relatedDocs.section`)
  - 에이전트에게 “문서 업데이트 필요” 액션을 제안

---

## 11. Implementation Plan (4 Workstreams)

> ADR-037은 5개 공백(Plain text + Code comments + Quality + Ops + Storage)을 다루되, 실제 구현은 4개 workstream 단위로 병렬/점진적으로 진행한다. (Code comments는 WS-A에 포함)

### 11.0 Code Map (Planned Files / Touch Points)

> 아래 경로는 “권장”이며, 기존 구조를 최대한 재사용한다(ADR-036의 `DocumentProfiler/DocumentIndexer/DocumentSearchEngine` 기반).

**WS-A (Plain Text Support)**
- Add: `smart-context-mcp/src/documents/text/TextHeuristics.ts`
- Add: `smart-context-mcp/src/documents/text/TextChunker.ts`
- Add: `smart-context-mcp/src/documents/html/HtmlTextExtractor.ts` (HTML 1차: visible text 추출)
- Add: `smart-context-mcp/src/documents/html/TreeSitterHtmlParser.ts` (HTML 2차: tree-sitter 기반 구조 파싱)
- Modify: `smart-context-mcp/src/indexing/DocumentIndexer.ts` (지원 확장자/파일명 + size cap/sampling + kind=text)
- Modify: `smart-context-mcp/src/documents/DocumentProfiler.ts` (text kind outline/links/mentions best-effort)
- Add: `smart-context-mcp/src/indexing/CommentIndexer.ts` (code → code_comment chunks)
- Modify: `smart-context-mcp/src/indexing/IncrementalIndexer.ts` (코드 파일 변경 시 CommentIndexer 호출)

**WS-B (Evidence Contract)**
- Modify: `smart-context-mcp/src/documents/search/DocumentSearchEngine.ts` (evidence 동적 fill + degraded/reasons 표준화)
- Modify: `smart-context-mcp/src/index.ts` (`doc_search` 응답 계약 반영 및 문서화 필드 고정)

**WS-C (Embedding Ops)**
- Add: `smart-context-mcp/src/embeddings/EmbeddingQueue.ts` (concurrency/queue/timeout)
- Add: `smart-context-mcp/src/cli/warmup-embeddings.ts` (모델 워밍업)
- Modify: `smart-context-mcp/src/embeddings/TransformersEmbeddingProvider.ts` (cache env bridge + queue 사용)
- Modify: `smart-context-mcp/src/embeddings/EmbeddingConfig.ts` (timeout/concurrency/queue/env)

**WS-D (Storage v4)**
- Modify: `smart-context-mcp/src/indexing/Migrations.ts` (schema v4)
- Modify: `smart-context-mcp/src/indexing/EmbeddingRepository.ts` (복합키 + 조회/업서트 수정)
- Modify: `smart-context-mcp/src/indexing/DocumentChunkRepository.ts` (프루닝/인덱스 활용 보강, 필요 시)

### 11.1 Code Comments Integration Notes

> ADR-037의 “코드 주석 포함”은 **코드에 주석을 더 쓰자**가 아니라, 이미 존재하는 주석을 **텍스트 코퍼스**로 취급하여 검색/근거에 포함시키자는 의미다.

- 우선순위: “문서화 주석”(JSDoc/docstring/leading block) 중심으로 low-noise 코퍼스를 만든다.
- 저장: `document_chunks.kind="code_comment"` 로 분리(출처 투명성 + 가중치 튜닝 분리).
- 연결: `section_path_json`에 symbol path를 저장해 `doc_section` 기반 탐색이 가능해야 한다.
- 폴백: tree-sitter 미지원 언어는 regex 기반으로 최소 기능 제공(그리고 degraded/reason으로 명시).

### WS-A: Plain Text Support

- DocumentIndexer 확장(지원 확장자/파일명 + size cap + sampling)
- Text outline heuristics + window chunker
- `doc_*` 전부에서 `kind="text"`가 동작하도록 보장
- 테스트:
  - outline/section range 정확성
  - size cap/sampling 적용 시 degraded 사유 포함

### WS-B: Retrieval Quality & Evidence Contract

- `doc_search`의 evidence 동적 fill 계약 고정
- degraded reason 표준화(embedding_timeout/evidence_truncated 등)
- Golden set + metrics 스캐폴딩(최소)

### WS-C: Embedding Ops

- 캐시 경로 표준화(`SMART_CONTEXT_MODEL_CACHE_DIR`)
- 워밍업 CLI 추가
- 동시성/타임아웃/큐잉 레이어 추가
- progressive eager(옵션) 도입

### WS-D: Scalable Storage v4

- 마이그레이션 v4(복합키 + 인덱스 + 프루닝 훅)
- EmbeddingRepository/쿼리의 batch 최적화(옵션)
- 대규모 DB에서의 VACUUM/프루닝 가이드 문서화

---

## 12. Testing Strategy (ADR-037)

- Unit
  - Text outline heuristic 케이스(underline/numbered/all-caps)
  - Chunk window overlap 안정성(누락/중복 검증)
  - Code comment extraction (JSDoc/docstring/leading comments)
  - HTML text extraction(1차) + tree-sitter HTML headings/references(2차)
  - CSS text indexing(1차) minified/size cap/sampling 동작
  - Evidence contract(상한/동적 fill/트렁케이션)
  - Embedding queue(동시성/타임아웃/부분 degraded)
  - Migration v4(기존 데이터 이관/인덱스 존재)
- Integration
  - ChangePillar에서 `relatedDocs.section` 첨부 여부
  - UnderstandPillar 문서 대상에서 `mentions → relatedCode` 동작

---

## 13. Risks / Mitigations (구체화)

- 인덱싱 비용 증가 → size cap + sampling + opt-in 확장자 + 백그라운드 점진 임베딩
- DB 비대화 → v4 인덱스/프루닝/TTL, provider/model 전환 시 데이터 안전
- 복잡도 상승 → workstream 분리 + degradation 계약 표준화(디버깅 가능)
- 품질 불확실성 → Markdown 권장 명세 + Text는 “best-effort”로 정의, evidence/투명성 강화
- 임베딩 리스크(로컬 부하) → concurrency/queue/timeouts + warmup + progressive eager
- 검색/랭킹 튜닝 부담 → golden set + metrics + 레버 명확화(MMR/RRF/caps)
- “무엇이 답인지” 논쟁 → 근거 다양성/정합성/불일치 노출 + 에이전트 판단 지원

---

## 14. Success Metrics

- 문서/텍스트 검색 Precision@K 상승(최소 K=5)
- `doc_search` p95 < 2.5s(로컬 임베딩 포함 시 degraded 허용)
- 모델 워밍업 이후 첫 요청 타임아웃 0회(로컬 환경)
- DB 크기/프루닝 정책 적용 시 “일정 크기 내 수렴”
- Change 흐름에서 “관련 문서 업데이트” 추천의 실제 채택률 상승
