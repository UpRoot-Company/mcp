# ADR-036: Universal Document Support (Markdown/MDX-first)

**Status:** Proposed  
**Date:** 2025-12-30  
**Author:** Architecture Team  
**Related ADRs:** ADR-033 (Six Pillars), ADR-014 (Smart File Profile / Skeleton-first), ADR-022 (SQLite/WAL), ADR-023 (Indexing & Gap Remediation), ADR-034/035 (Budgets & Degradation)

---

## 1. Executive Summary

Smart Context MCP는 현재 **코드(code) 중심**으로 최적화되어 있습니다(트리-시터 기반 AST, skeleton-first 출력, 심볼/의존성 그래프). 그러나 실제 작업 흐름에서 에이전트는 코드만이 아니라 **프로젝트 문서(특히 Markdown/MDX)** 를 함께 읽고, 탐색하고, 요약하고, 코드와 연결해야 합니다.

본 ADR은 smart-context-mcp를 **Markdown/MDX 문서까지 확장**하기 위한 범용 문서 지원(Universal Document Support) 설계를 제안합니다.

핵심 결정은 다음 두 가지입니다.

1) **파서 레이어**: Markdown은 **tree-sitter-markdown WASM** 기반 구조 파싱을 1순위로 사용하고(견고한 섹션/링크/코드블록 인식), 빌드/로딩 실패 시 **remark(임시 폴백)** 로 대체합니다. MDX는 Phase 1에서 remark 기반으로 지원하고, tree-sitter 기반 `.mdx` 지원은 Phase 2~3에서 별도 도입 여부를 결정합니다.  
2) **임베딩 레이어**: 임베딩은 **OpenAI 우선**(환경변수/설정 감지)으로 사용하되, 사용 불가 시 **로컬(@xenova/transformers MiniLM 계열) 폴백**으로 비용/오프라인 요구를 만족합니다.

또한, 문서 chunk/embedding을 **SQLite(IndexDatabase)** 에 영속화하고, 기존 BM25/트라이그램 신호와 결합한 **하이브리드 검색(BM25 + Vector)** 을 통해 “문서의 *어느 섹션이 답인지*” 수준으로 정확도를 끌어올립니다. 인덱싱 대상은 **프로젝트 전체의 `.md`/`.mdx`** 입니다.

---

## 2. Problem Statement

### 2.1 현재 상태(코드 중심)

- `read`는 코드 skeleton/fragment를 제공하지만, Markdown에 대해선 의미 있는 “목차/섹션/요약”을 제공하지 못합니다.
- `navigate`는 `.md/.mdx` 파일을 “doc”으로 분류는 하지만, 문서 내부의 구조(TOC), 레퍼런스 링크(참조 관계), 섹션 단위 이동이 부족합니다.
- `search_project`는 키워드 검색엔 강하지만, 문서 답변에 중요한 “의미적 유사도(semantic)”를 활용하지 못합니다.

### 2.2 요구사항(문서 확장)

- Markdown/MDX를 코드처럼 **구조적으로 읽기**: TOC/섹션 단위로 skeleton/fragment 제공
- 전체 프로젝트의 `.md`/`.mdx`를 대상으로 인덱싱/검색 가능해야 함
- 문서 간 **링크/참조 탐색**: “이 문서가 어디를 링크하나?” “이 섹션이 어디서 참조되나?”
- 문서 검색 품질 개선: 키워드(BM25) + 의미적 유사도(벡터) 하이브리드
- 운영 제약: 임베딩 비용/네트워크 불가 환경에서의 동작(로컬 폴백), WASM 빌드 실패 시 폴백

---

## 3. Goals / Non-Goals

### Goals

- Markdown/MDX(.md/.mdx) 문서에서 **Document Skeleton / Section Read / TOC / References** 를 제공한다.
- 기존 Six Pillars(`understand`, `read`, `navigate`)에 문서 워크플로우를 자연스럽게 통합한다.
- 임베딩은 “사용 가능하면 고품질(OpenAI), 아니면 로컬”로 **자동 선택**한다.
- 문서 chunk/embedding을 DB에 저장하고, 하이브리드 검색으로 **섹션 단위 정밀 응답**을 가능하게 한다.

### Non-Goals

- PDF/Word/HTML 등 모든 포맷을 즉시 지원(본 ADR은 Markdown-first이며 다른 포맷은 추후 확장).
- SQLite 벡터 확장(예: sqlite-vss 등) 도입을 전제로 한 ANN(근사 최근접) 구현(초기엔 후보 제한 + 선형 스캔 허용).
- 문서 “작성/자동 수정”까지 범용화(우선은 읽기/탐색/이해 중심).

---

## 4. Decision

### 4.1 Document Pipeline 도입

문서 파일(.md/.mdx)을 코드 파일과 구분된 파이프라인으로 취급한다.

```
File (.md/.mdx)
  └─ DocumentProfiler(메타/프론트매터/링크)
      └─ DocumentParser(우선: tree-sitter-markdown, 폴백: remark)
          └─ Outline/Sections 생성
              └─ Chunking(헤딩 기반)
                  └─ (옵션) Embedding 생성/저장
                      └─ Hybrid Retrieval(BM25/트라이그램 + Vector)
```

### 4.2 Markdown 파싱 우선순위

1) **tree-sitter-markdown WASM**: 구조 파싱(헤딩/링크/코드펜스) 안정성 확보  
2) **remark 폴백**: WASM 빌드/로딩 실패, 런타임 환경 제약 시에도 최소 기능(TOC/섹션)을 유지

### 4.3 임베딩 제공자 선택(자동)

- `EmbeddingProviderFactory`: OpenAI 사용 가능 여부를 감지하여 우선 사용
- 불가 시 `@xenova/transformers` 기반 로컬 모델로 폴백
- 둘 다 불가하면 임베딩 비활성화(키워드/BM25만으로 동작)

---

## 5. Type System Design (types.ts 확장 명세)

> **주의:** 현재 `types.ts`에는 이미 `Document { id, text, score }` 타입이 존재(BM25 문서 표현). 본 ADR의 “문서 지원”은 의미 범위가 더 넓으므로, 구현 시에는 충돌을 피하기 위해 기존 타입을 `SearchDocument`로 리네이밍하거나(권장), 본 ADR의 타입에는 명확한 접두어를 사용합니다(예: `UniversalDocument*`).

### 5.1 Core Types

```ts
export type DocumentKind = "markdown" | "mdx" | "text" | "unknown";

export interface DocumentSection {
  /** Stable section id (ex: `${filePath}#${slugPath}` or hash) */
  id: string;
  filePath: string;
  kind: DocumentKind;

  /** Heading info */
  title: string;
  level: number;           // e.g. 1..6 for markdown headings
  path: string[];          // ancestor titles (for stable navigation)

  /** Source range (byte-precise preferred) */
  range: { startLine: number; endLine: number; startByte: number; endByte: number };

  /** Optional derived data */
  contentHash?: string;
  summary?: string;
}

export interface DocumentProfile {
  filePath: string;
  kind: DocumentKind;
  title?: string;

  /** Markdown frontmatter (if present) */
  frontmatter?: Record<string, unknown>;

  /** Outline and sections */
  outline: DocumentSection[];

  /** Derived link graph */
  links?: Array<{
    text?: string;
    href: string;
    resolvedPath?: string;
    hashFragment?: string;
    range?: { startLine: number; endLine: number; startByte: number; endByte: number };
  }>;

  /** Basic stats */
  stats: { lineCount: number; charCount: number; headingCount: number };
}

export interface DocumentOutlineOptions {
  /** 최대 heading depth. 예: 3이면 H1~H3만 */
  maxDepth?: number;
  /** 프론트매터 파싱 포함 여부 */
  includeFrontmatter?: boolean;
  /** 코드블록을 outline/summary에 포함할지 */
  includeCodeBlocks?: boolean;
  /** 리스트를 chunk로 분리/보존할지 (structural chunking) */
  includeLists?: boolean;
  /** 표(테이블)를 chunk로 분리/보존할지 (structural chunking) */
  includeTables?: boolean;
  /** 섹션이 너무 작을 때 합치기 기준 */
  minSectionChars?: number;
  /** chunking 정책 */
  chunkStrategy?: "heading" | "structural" | "fixed";
  /** fixed chunking 기준(대략) */
  targetChunkChars?: number;
  /** structural chunking에서 block 단위 최대 크기(대략). 초과 시 block을 잘라 여러 chunk로 분리 */
  maxBlockChars?: number;
}
```

### 5.2 Embedding Types

```ts
export type EmbeddingProvider = "openai" | "local" | "disabled";

export interface EmbeddingVector {
  provider: EmbeddingProvider;
  model: string;
  dims: number;
  values: Float32Array;
  /** optional: l2 norm (if normalized vectors) */
  norm?: number;
}

export interface EmbeddingConfig {
  provider?: "auto" | EmbeddingProvider;
  normalize?: boolean;
  batchSize?: number;
  openai?: {
    apiKeyEnv?: string; // default: OPENAI_API_KEY
    model: string;
  };
  local?: {
    model: string;      // e.g. Xenova/all-MiniLM-L6-v2
    device?: "cpu" | "auto";
    quantized?: boolean;
  };
}
```

---

## 6. Parser Layer Design (MarkdownAstBackend)

### 6.1 구조

- `MarkdownAstBackend`는 `.md` 파일을 파싱하여 “헤딩/섹션/링크” 중심의 최소 AST를 제공한다.
- `.mdx`는 Phase 1에서는 remark 기반으로 처리하며(최소 기능 제공), tree-sitter 기반 지원은 Phase 2~3에서 선택한다.
- 구현은 기존 `WebTreeSitterBackend.ts` 패턴을 따라:
  - (1) WASM 로더 초기화
  - (2) languageId에 따른 wasm 로딩
  - (3) Query 기반으로 heading/link 노드를 추출

#### 6.1.1 파일 타입 판별(구현 규칙)

- 대상 확장자: `.md`, `.mdx`
- `DocumentKind` 매핑:
  - `.md` → `"markdown"`
  - `.mdx` → `"mdx"`
- 파서 선택(의사코드):

```ts
function selectParser(filePath: string): "tree-sitter-md" | "remark-md" | "remark-mdx" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mdx") return "remark-mdx";          // Phase 1 기본
  if (ext === ".md") return canLoadMarkdownWasm() ? "tree-sitter-md" : "remark-md";
  return "remark-md";
}
```

### 6.2 tree-sitter-markdown 커스텀 WASM 빌드

`web-tree-sitter` 런타임이 로딩할 수 있는 `tree-sitter-markdown.wasm`을 생성한다.

권장 절차(프로젝트 스크립트화):

1. `tree-sitter-markdown` grammar 소스 준비(서브모듈/벤더링/다운로드 중 택1)
2. 빌드 환경 준비(emscripten 또는 tree-sitter CLI의 wasm 빌드 지원)
3. 출력 파일명을 `tree-sitter-markdown.wasm`으로 고정
4. 배포 경로에 복사:
   - 런타임에서 `SMART_CONTEXT_WASM_DIR`를 우선 사용(권장)
   - 또는 `node_modules/tree-sitter-wasms/out/`에 포함(현재 배포 전략과 호환)

실패 시 동작:
- WASM 로딩 실패 → `remark` 폴백으로 자동 전환(기능 축소 + 안내 메시지)

### 6.3 remark 임시 폴백 전략

Phase 1에서는 성능/정확성보다 “기능 제공”이 우선이므로, 다음을 지원한다.

- 프론트매터 파싱(`gray-matter` 또는 remark 플러그인)
- 헤딩 기반 outline 추출
- 링크/이미지 href 수집
- 섹션 텍스트 추출(헤딩 경계 기준)
- MDX(`.mdx`)는 remark 기반으로 파싱하고, JSX 블록은 텍스트로 보존(초기)

#### 6.3.1 MDX 텍스트 추출 정책(Phase 1)

- 목표: 검색/요약용 “사람이 읽는 텍스트”를 최대한 보존하되, JSX/표현식이 노이즈가 되지 않게 한다.
- 결정(품질 우선): “placeholder만 남기기”보다 **의미 있는 텍스트를 최대한 보존**한다(다만 noise는 통제).
- 권장 규칙(구현 가능 버전):
  - MDX JSX 요소는 “컴포넌트 이름 + 안전한 props 요약”을 남긴 placeholder로 치환:
    - 예: `<Callout type="warning" title="Caution" />` → `[[mdx:Callout type="warning" title="Caution"]]`
    - 안전한 props: string/number/boolean literal만 포함(표현식/객체/배열은 제외)
  - `<Component>...</Component>`의 children은:
    - children이 plain text/markdown 노드면 그대로 보존
    - children이 JSX/표현식이면 placeholder로 축약
  - `{expression}`은 가능한 경우 “핵심 식별자”만 남김:
    - `{userId}` → `[[mdx:userId]]`
    - 복잡한 표현식은 `[[mdx:expr]]`
  - 코드펜스는 기본 포함(검색 정확도↑)하되, 옵션(`includeCodeBlocks=false`)에서 제외 가능

---

## 7. Embedding Layer Design

### 7.1 Provider Strategy

`EmbeddingProviderFactory`:

- `provider=auto`일 때:
  - `OPENAI_API_KEY`(또는 설정된 env) 존재 → OpenAI Provider
  - 없으면 Local Provider
  - 로컬 모델 로딩 실패 → Disabled Provider

### 7.1.1 임베딩 기본값(auto vs disabled)의 차이

임베딩 기본값은 “문서 인덱싱/검색에서 **벡터를 기본으로 생성/사용하느냐**”를 결정합니다.

- 기본값이 `disabled`일 때:
  - 장점: 인덱싱/시작이 빠르고(모델 로딩/네트워크 호출 없음), 비용·프라이버시 리스크가 최소화됨
  - 단점: 자연어형 질의(“이 개념 설명한 섹션 찾아줘”) 정확도가 BM25 중심으로 제한됨
- 기본값이 `auto`일 때:
  - 장점: OpenAI(가능 시) 또는 로컬 임베딩을 활용해 섹션 단위 검색 정확도 상승(semantic)
  - 단점: 프로젝트 전체 `.md/.mdx` 대상에 대해 임베딩을 eager 생성하면 CPU/시간/DB 사용량이 커질 수 있고, OpenAI 사용 시 비용/키 관리가 필요함

권장(본 ADR): 기본 provider는 `auto`를 유지하되, Phase 3에서는 **임베딩 생성은 “lazy(요청 시 생성) + 캐시”를 기본**으로 두고, 운영자가 명시적으로 eager를 선택할 수 있게 한다.

#### 7.1.2 Lazy vs Eager 생성(구현 규칙)

- 기본(lazy):
  - 문서 chunk는 항상 생성/저장(`document_chunks`)
  - 임베딩은 아래 트리거에서만 생성/저장(`chunk_embeddings`)
- 트리거(예시):
  1) `doc_search`에서 vector 기반 정밀도가 필요하고 provider가 enabled일 때
  2) `navigate(context="docs")` 또는 `understand(goal=...)`에서 “유사 섹션 추천”이 필요하고 provider가 enabled일 때
  2) `manage(command="rebuild")`에서 운영자가 `SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER=true`를 켠 경우
- 캐시:
  - 프로세스 메모리 LRU(옵션): 최근 N개 chunk vector 캐시
  - DB 캐시: `(chunk_id, provider, model)` 단위로 재사용
- 무효화:
  - `document_chunks.content_hash`가 바뀌면 해당 chunk의 embedding은 재생성(업서트)

#### 7.1.3 로컬 임베딩 부하 분산(필수 가드레일)

로컬(`@xenova/transformers`)은 “무료”지만 CPU/메모리/콜드스타트 비용이 있습니다. 프로젝트 전체 `.md/.mdx`를 대상으로 할 때는 아래 가드레일이 필요합니다.

- **백그라운드 큐 + 우선순위**
  - 우선순위: (1) 사용자가 지금 찾는 문서 섹션 (2) 최근 변경된 문서 (3) 나머지
  - 큐는 작은 배치로 처리하고, 이벤트 폭주 시 debounce/merge(ADR-035의 soft degradation과 정합)
- **동시성 제한**
  - 임베딩 생성 동시 실행 수를 1~2로 제한(기본 1)
  - 요청 처리(검색/읽기)가 밀리지 않게 “idle time”에만 처리하는 모드 지원
- **시간 예산(budget)**
  - 요청당 `maxEmbeddingTimeMs`, `maxChunksEmbeddedPerRequest`를 두고 초과 시 `degraded: true`로 반환
  - 부족하면 “키워드 기반 TopK + 임베딩 생성 중” 형태로 부분 결과를 먼저 제공
- **모델 로딩/캐시**
  - 프로세스 단위로 모델은 1회 로드(싱글톤)
  - vector는 DB에 저장 후 재사용(중복 생성 방지)
  - cold start를 피하기 위해 `manage(command="warmup")` 또는 최초 1회 작은 샘플 임베딩으로 워밍업(선택)

### 7.2 VectorIndex 저장소

초기 구현은 “정확도 우선 + 단순성”을 위해 DB 기반 저장을 채택한다.

- 저장: `chunk_embeddings` 테이블에 `(chunk_id, provider, model, dims, vector_blob, norm)` 업서트
- 검색:
  - 후보 문서/섹션을 먼저 좁힌 뒤(키워드/파일 후보), 그 subset의 벡터만 로드하여 cosine/dot 유사도 계산
  - Phase 3 이후에 필요 시:
    - 자주 쓰는 코퍼스에 대해 in-memory cache(LRU) 도입
    - ANN 도입은 별도 ADR로 분리

### 7.3 Hybrid Retrieval (BM25 + Vector)

하이브리드 스코어링 규칙(예시):

- `bm25Score`(기존 검색 신호)와 `vectorScore`(cosine similarity)를 정규화 후 가중합:
  - `final = 0.6 * bm25 + 0.4 * vector`
- 질의가 짧고 키워드성일수록 BM25 가중치↑
- 질의가 자연어 설명/요약형일수록 벡터 가중치↑

출력은 **파일이 아니라 “섹션(chunk)”** 을 1차 결과로 반환한다:

- `filePath`, `sectionId`, `headingPath`, `preview`, `scores { bm25, vector, final }`

#### 7.3.1 Retrieval 파이프라인(구현 규칙)

문서 검색은 “파일 후보 → 섹션 후보”의 2단계로 처리한다.

1) **파일 후보 수집(빠른 단계)**
- `search_project(query, type="file")`를 사용하되, includeGlobs를 `.md/.mdx`로 제한:
  - `includeGlobs: ["**/*.md", "**/*.mdx"]`
- 결과 상위 N개 파일을 후보로 선정(N은 budget 기반, 예: 30~80)

2) **섹션 후보 로드(정확 단계)**
- 후보 파일들에 대해 `document_chunks`를 로드
- 각 chunk에 대해:
  - `bm25Score`: chunk 텍스트 기반(간이 BM25 또는 existing BM25FRanking 재사용)
  - `vectorScore`: provider enabled일 때 cosine similarity
- 최종 `finalScore`로 TopK 섹션을 반환

3) **응답 구성**
- `doc_section`으로 TopK 섹션의 실제 내용을 필요만큼 로드(토큰/라인 제한)
- `read`/`understand` 응답에는 “섹션 중심” preview를 포함하고, 필요 시 full section을 추가로 read하도록 guidance 제공

#### 7.3.2 랭킹 튜닝 비용을 낮추는 기본 전략(권장)

“BM25 + 벡터” 가중치 튜닝은 유지보수 부담이 될 수 있으므로, 다음의 단순하고 검증된 조합을 기본으로 둡니다.

- **RRF(Reciprocal Rank Fusion) 기반 하이브리드**
  - BM25 TopN, Vector TopN을 각각 만든 뒤 RRF로 합성(가중치 튜닝 대신 랭크 기반 결합)
  - 장점: 스케일/정규화 민감도가 낮고 운영이 쉬움
  - 권장 기본값: `k=60`, `TopN=200`
- **(옵션) Reranker 단계**
  - TopK 후보(예: 20~50)에 대해서만 cross-encoder 또는 LLM 기반 rerank를 추가(Phase 3~4)
  - OpenAI가 가능하면 고품질 rerank, 불가하면 로컬 경량 모델로 폴백(비용/성능 trade-off)
- **다양성(MMR)**
  - TopK가 한 문서/한 섹션에 쏠리면 MMR로 중복을 줄이고 “근거 폭”을 넓힘(Phase 4에서 특히 유용)

참고:
- RRF는 점수 정규화 없이도 합성이 가능한 “랭크 기반 fusion”으로, BM25/벡터를 함께 쓸 때 운영 난이도를 낮춘다.
- Vespa는 `reciprocal_rank_fusion()` 및 phased ranking을 제공한다(운영 모델로 참고 가능).

RRF 공식(구현용):

```text
score(d) = Σ_i 1 / (k + rank_i(d))
  - i: 랭킹 리스트(BM25, Vector, ...)
  - rank_i(d): i번째 리스트에서 d의 1-based rank (없으면 0으로 취급)
```

MMR 공식(구현용, 선택):

```text
MMR(d) = λ * Rel(d) - (1-λ) * max_{s ∈ Selected} Sim(d, s)
  - Rel: RRF 점수(또는 rerank 점수)
  - Sim: cosine(embedding) 또는 token-overlap(폴백)
  - 권장 기본값: λ=0.7
```

#### 7.3.3 Rerank 기본 정책(결정: 품질 우선)

- 기본: **RRF로 후보를 만든 뒤, OpenAI가 가능하면 rerank를 수행**한다.
  - OpenAI 사용 가능 → LLM 기반 rerank(기본)
  - OpenAI 불가 → **rerank 생략(로컬 reranker는 도입하지 않음)** + 근거 섹션(TopK)을 더 많이 반환
- budget(필수):
  - `maxRerankCandidates` 기본 30
  - `maxRerankTokens`/`maxRerankTimeMs` 초과 시 rerank 생략 + 근거 섹션을 더 많이 반환(투명성 유지)

근거 섹션 “동적 확장”(결정):
- rerank를 생략하는 경우, **고정 개수 대신** 아래 상한(max) 내에서 가능한 만큼 반환한다.
  - 예: `maxEvidenceSections`, `maxEvidenceChars`, `maxEvidenceTimeMs`
- 구현 규칙:
  - 결과 생성은 “섹션 preview” 기준으로 먼저 채우고(빠름), 사용자가 요청하면 `doc_section`으로 full section을 추가로 제공
  - budget이 빠듯하면 `degraded: true` + “근거를 더 보려면 read/doc_section 호출” 가이던스를 제공

#### 7.3.4 MMR 기본 정책(결정: 다양성 기본 ON)

- 기본: **MMR를 기본으로 적용**해 TopK 결과가 한 문서/한 섹션에 쏠리는 것을 줄인다.
- 적용 시점:
  - rerank를 수행한 경우: rerank 점수를 `Rel(d)`로 사용
  - rerank를 생략한 경우: RRF 점수를 `Rel(d)`로 사용
- `Sim(d,s)`:
  - provider enabled + embedding 존재 → cosine similarity
  - embedding이 없으면 텍스트 유사도(간단한 token overlap / Jaccard)로 폴백
- 출력:
  - `results`: MMR 적용 후 최종 TopK
  - `evidence`: (선택) MMR 적용 전 상위 후보(디버그/투명성 목적, 기본 off)

---

## 8. DB Schema Extension (IndexDatabase + Migrations)

### 8.1 Tables

`IndexDatabase`(SQLite)에 다음 테이블을 추가한다.

```sql
-- 문서 섹션/청크 저장
CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,                -- stable chunk id
  file_id INTEGER NOT NULL,           -- references files.id
  kind TEXT NOT NULL,                 -- markdown, ...
  section_path_json TEXT NOT NULL,    -- JSON string array
  heading TEXT,
  heading_level INTEGER,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_file ON document_chunks(file_id);

-- 임베딩 저장
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,          -- Float32Array (little-endian)
  norm REAL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(provider, model);
```

### 8.2 Migrations

- `smart-context-mcp/src/indexing/Migrations.ts`에 `version: 3` 이상으로 추가
- WAL/foreign key 설정은 기존 `IndexDatabase.configure()`를 그대로 따름

#### 8.2.1 Migration 구현 예시(version 3)

```ts
{
  version: 3,
  name: "document_chunks_and_embeddings",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        file_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        section_path_json TEXT NOT NULL,
        heading TEXT,
        heading_level INTEGER,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_byte INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_document_chunks_file ON document_chunks(file_id);

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        norm REAL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(provider, model);
    `);
    db.prepare(`INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '3')`).run();
  }
}
```

### 8.3 Repository/Statement 설계(구현 가이드)

DB 접근은 `IndexDatabase`에 직접 메서드를 계속 추가하기보다, 문서 전용 레이어를 둔다.

- 권장 파일:
  - `smart-context-mcp/src/indexing/DocumentChunkRepository.ts`
  - `smart-context-mcp/src/indexing/EmbeddingRepository.ts`
- 최소 API(예시):

```ts
export interface StoredDocumentChunk {
  id: string;
  filePath: string;
  kind: "markdown" | "mdx";
  sectionPath: string[];
  heading: string | null;
  headingLevel: number | null;
  range: { startLine: number; endLine: number; startByte: number; endByte: number };
  text: string;
  contentHash: string;
  updatedAt: number;
}

export class DocumentChunkRepository {
  upsertChunksForFile(filePath: string, chunks: StoredDocumentChunk[]): void;
  deleteChunksForFile(filePath: string): void;
  listChunksForFile(filePath: string): StoredDocumentChunk[];
}

export class EmbeddingRepository {
  upsertEmbedding(chunkId: string, embedding: { provider: string; model: string; dims: number; vector: Float32Array; norm?: number }): void;
  getEmbedding(chunkId: string, provider: string, model: string): { vector: Float32Array; dims: number; norm?: number } | null;
  deleteEmbedding(chunkId: string): void;
}
```

Vector 직렬화(권장):
- `Float32Array` → `Buffer.from(new Uint8Array(values.buffer))` (little-endian 가정)
- 역직렬화: `new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)`

#### 8.3.1 Upsert 트랜잭션 규칙(필수)

문서 chunk는 “파일 단위”로 정합성이 중요하므로, 아래를 한 트랜잭션으로 처리합니다.

- `getOrCreateFile(relativePath, mtime, language)`로 `files` 레코드 확보
- `DELETE FROM document_chunks WHERE file_id = ?`
- `INSERT INTO document_chunks ...` (새 chunk 전체)
- (선택) eager 임베딩 모드라면 `chunk_embeddings`도 같은 트랜잭션 또는 별도 배치로 업서트

---

## 9. Component Design

### 9.1 MarkdownSkeletonGenerator (SkeletonGenerator 확장)

목표: 코드의 skeleton-first 경험을 문서에도 제공.

- 입력: `(filePath, content, options: DocumentOutlineOptions)`
- 출력: 사람이 읽기 쉬운 “목차 + 섹션 요약” 문자열
- 규칙(예시):
  - heading 트리 출력(H1~Hn)
  - 각 섹션에 1~2줄 요약(Phase 2 이후 선택)
  - 링크/참조 개수 집계(문서 탐색 신호로 사용)

### 9.2 DocumentProfiler (FileProfiler 확장)

`FileProfiler.analyzeMetadata()`는 포맷(개행/indent) 중심이므로, 문서 전용 profiler를 별도 도입한다.

- 역할:
  - frontmatter 파싱
  - 제목 추정(H1 또는 frontmatter title)
  - 링크 추출 및 `DocumentLinkResolver`로 해석
  - outline 생성(파서 레이어 호출)

### 9.3 DocumentLinkResolver

- Markdown 링크 `[](./path.md#section)`을 해석하여:
  - `resolvedPath`(프로젝트 루트 기준)
  - `hashFragment`(heading anchor)
  - 존재/유효성 검사(옵션)
- `navigate`의 `doc_references` 및 `doc_backlinks`(향후)에서 사용

### 9.4 DocumentIndexer(Incremental) 설계

문서 인덱싱은 기존 `IncrementalIndexer`(코드 심볼/의존성 중심)와 분리된 경로로 처리한다.

- 권장 파일:
  - `smart-context-mcp/src/indexing/DocumentIndexer.ts`
  - `smart-context-mcp/src/documents/DocumentProfiler.ts`
  - `smart-context-mcp/src/documents/parsers/*`
  - `smart-context-mcp/src/documents/chunking/*`
- 트리거:
  - 파일 add/change: `.md/.mdx` → `DocumentIndexer.indexFile(absPath)`
  - 파일 unlink: `.md/.mdx` → `DocumentIndexer.deleteFile(absPath)`
- `IncrementalIndexer` 통합(구현 방향):
  - 현재 `enqueuePath()`는 `SymbolIndex.isSupported()`만 통과시켜 `.md/.mdx`를 무시함.
  - 해결: `DocumentIndexer.isSupported()`를 추가로 검사하여 문서도 별도 큐로 처리(코드 큐와 독립).
  - 문서 인덱싱은 의존성 그래프/심볼 인덱스와 결합하지 않고, `IndexDatabase`의 `files`/`document_chunks`만 갱신한다.

#### 9.4.1 `DocumentIndexer.indexFile()` 의사코드(Phase 1 기준)

```ts
async function indexFile(absPath: string) {
  if (!isSupported(absPath)) return;
  const relativePath = toRelative(absPath);                 // PathManager/root 기준
  if (shouldIgnore(relativePath)) return;

  const content = await fileSystem.readFile(absPath);
  const mtime = (await fileSystem.stat(absPath)).mtimeMs;

  const kind = ext === ".mdx" ? "mdx" : "markdown";
  const profile = await documentProfiler.profile({ filePath: relativePath, content, kind });
  const chunks = headingChunker.chunk(profile, content);

  chunkRepo.upsertChunksForFile(relativePath, chunks.map(toStoredChunk));
}
```

#### 9.4.2 ignore 패턴/스코프(필수)

문서 인덱싱은 “전체 프로젝트”가 대상이지만, 기존 ignore 정책과 일관되어야 합니다.

- `.gitignore` 및 `ConfigurationManager`의 ignore 변경(`ignoreChanged`)을 문서 인덱서에도 반영
- 권장: `SmartContextServer.applyIgnorePatterns()`에서 `DocumentIndexer.updateIgnorePatterns(patterns)`를 함께 호출
- 최소: `DocumentIndexer`는 `ignore` 패키지로 동일한 필터를 구성하고, `shouldIgnore(relativePath)`를 제공

### 9.5 Chunk ID / Section ID 규칙(안정성)

구현에서 가장 중요한 것은 “섹션을 안정적으로 다시 찾기”입니다.

- `sectionPath`는 heading ancestor의 텍스트 배열(정규화된 slug가 아니라 원문 title을 저장)
- `chunkId`는 다음을 권장:
  - `sha256("${filePath}\n${sectionPath.join(" > ")}\n${ordinalWithinSameHeading}")`
- 이유:
  - 라인/바이트 기반 ID는 편집에 취약(작은 삽입으로도 전체 범위가 흔들림)
  - heading-path 기반 ID는 “섹션 이동”에 비교적 안정적

#### 9.5.1 Heading 정규화 규칙(권장)

`headingPath` 매칭은 사람이 입력하는 경우가 많아 오타/공백 차이가 생깁니다.

- 저장은 원문 title로 유지(`sectionPath_json`)
- 매칭은 정규화 비교를 병행:
  - trim
  - 공백 연속 축약
  - 소문자 비교(옵션)
  - 기호 제거(옵션, 단계적)

---

## 10. Six Pillars Integration

> 원칙: 에이전트 인터페이스(6 pillars)는 “What”에 집중하고, 문서/코드 세부 처리는 내부 도구로 숨긴다(ADR-033).

### 10.1 Internal Tools (InternalToolRegistry 등록)

신규 내부 도구(제안):

- `doc_analyze`
  - 입력: `{ filePath, options? }`
  - 출력: `DocumentProfile + 요약 + 관련 링크`
- `doc_skeleton`
  - 입력: `{ filePath, options? }`
  - 출력: skeleton 문자열 + outline
- `doc_section`
  - 입력: `{ filePath, sectionId | headingPath, view?: "full"|"fragment" }`
  - 출력: 해당 섹션 텍스트(+ 범위/메타)
- `doc_toc`
  - 입력: `{ filePath, maxDepth? }`
  - 출력: heading tree
- `doc_references`
  - 입력: `{ filePath }`
  - 출력: outbound 링크 목록(+ resolvedPath)
- `doc_search` (Phase 3)
  - 입력: `{ query, maxResults?, includeGlobs?, embedding?: { provider?: "auto"|"openai"|"local"|"disabled" } }`
  - 출력: section TopK (filePath, sectionId, scores, preview)

#### 10.1.1 Internal Tool Args/Result (구현용 TS 스펙)

```ts
export interface DocTocArgs { filePath: string; maxDepth?: number }
export interface DocTocResult { filePath: string; kind: "markdown" | "mdx"; outline: DocumentSection[] }

export interface DocSectionArgs {
  filePath: string;
  sectionId?: string;
  headingPath?: string[];           // exact match by title path
  includeSubsections?: boolean;     // default false
}
export interface DocSectionResult {
  filePath: string;
  kind: "markdown" | "mdx";
  section: DocumentSection;
  content: string;
}

export interface DocSkeletonArgs { filePath: string; options?: DocumentOutlineOptions }
export interface DocSkeletonResult { filePath: string; kind: "markdown" | "mdx"; skeleton: string; outline: DocumentSection[] }

export interface DocAnalyzeArgs { filePath: string; options?: DocumentOutlineOptions }
export interface DocAnalyzeResult { filePath: string; profile: DocumentProfile; skeleton: string }

export interface DocSearchArgs {
  query: string;
  maxResults?: number;
  includeGlobs?: string[];          // default: ["**/*.md","**/*.mdx"]
  embedding?: { provider?: "auto" | "openai" | "local" | "disabled" };
}

export interface DocSearchResultEntry {
  filePath: string;
  sectionId: string;
  headingPath: string[];
  preview: string;
  scores: { bm25: number; vector?: number; final: number };
}

export interface DocSearchResult {
  query: string;
  results: DocSearchResultEntry[];
  degraded?: boolean;
  reason?: string;
}
```

### 10.2 Pillar Behavior 확장

- `read`
  - 대상이 `.md/.mdx`이고 `view="skeleton"`이면 `doc_skeleton` 사용
  - 문서 fragment는 `lineRange` 대신 `sectionId | headingPath` 기반으로 제공(Phase 2+)
- `navigate` (`context="docs"`)
  - 파일 후보는 기존 `search_project(type="file")`를 활용하되
  - 문서 내부 탐색은 `doc_toc`, 문서 간 참조는 `doc_references`로 확장
- `understand`
  - goal/target이 문서이거나 `.md/.mdx`가 명시되면 `doc_analyze` 중심의 응답 구성
  - 코드 ↔ 문서 연결(Phase 4): 문서 섹션에서 언급된 심볼/파일을 `navigate`로 교차 확인

#### 10.2.1 `read` 확장 시그니처(제안)

결정: `read` 스키마에 `sectionId/headingPath`를 **정식 필드로 추가**한다(문서 섹션 read의 UX/정합성 우선).

 - 추가 필드:
  - `sectionId?: string`
  - `headingPath?: string[]`

대안:
- 에이전트 API 변경 없이 `read(target="file.md#section")` 같은 문자열 규칙으로 우회할 수 있지만(파싱 필요), 입력 오류가 늘어날 수 있습니다.

---

## 11. 4-Phase Implementation Plan

### Phase 1 — remark 기반 임시 문서 파서 + DocumentProfiler

- 목표: “문서도 읽을 수 있다”를 빠르게 제공
- 산출물:
  - remark/gray-matter 기반 outline + section 추출
  - `doc_skeleton`, `doc_section` 최소 구현
  - `read`에서 `.md/.mdx` skeleton 지원(옵션/실험 플래그 가능)
  - 문서 인덱싱 최소 경로: `DocumentIndexer`가 `document_chunks`만 갱신(임베딩 없음)

### Phase 2 — tree-sitter-markdown WASM + MarkdownSkeleton

- 목표: 구조 정확도/일관성 확보(heading 경계, 코드블록, 링크)
- 산출물:
  - `MarkdownAstBackend` 도입
  - `tree-sitter-markdown.wasm` 빌드/배포 파이프라인
  - skeleton 품질 개선(heading path 안정화, range 정확도)
  - `read`의 문서 fragment가 `sectionId/headingPath`를 이해하도록 확장(또는 target 문자열 규칙 확정)

### Phase 3 — EmbeddingProvider + VectorIndex + Hybrid Retrieval

- 목표: 문서 질의 응답 정확도(semantic) 향상
- 산출물:
  - `EmbeddingProviderFactory` + OpenAI/로컬 폴백
  - `document_chunks` / `chunk_embeddings` 저장 + incremental update
  - 하이브리드 랭킹(BM25/키워드 + vector)로 섹션 TopK 반환
  - lazy 생성 기본 + `SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER=true` opt-in 지원

### Phase 4 — Pillar 통합 + 코드-문서 연결

- 목표: 문서 작업 흐름을 Six Pillars에 완전히 통합
- 산출물:
  - `navigate(context="docs")`에서 TOC/References 제공
  - `understand`에서 doc_analyze 지원(문서 요약 + 관련 코드 링크)
  - “코드-문서 연결” 기능:
    - 문서 링크/언급 심볼을 탐지 → `navigate`/`search_project`로 확인
    - 코드 변경 시 관련 문서 후보 제안(향후 `change`와 연결)

---

## 16. Implementation Checklist (Ready-to-Build)

### 16.1 Files to Add/Modify (권장 경로)

- Add:
  - `smart-context-mcp/src/documents/DocumentProfiler.ts`
  - `smart-context-mcp/src/documents/DocumentLinkResolver.ts`
  - `smart-context-mcp/src/documents/chunking/HeadingChunker.ts`
  - `smart-context-mcp/src/documents/parsers/RemarkMarkdownParser.ts`
  - `smart-context-mcp/src/documents/parsers/RemarkMdxParser.ts`
  - `smart-context-mcp/src/documents/parsers/TreeSitterMarkdownParser.ts` (Phase 2)
  - `smart-context-mcp/src/indexing/DocumentIndexer.ts`
  - `smart-context-mcp/src/indexing/DocumentChunkRepository.ts`
  - `smart-context-mcp/src/indexing/EmbeddingRepository.ts` (Phase 3)
  - `smart-context-mcp/src/embeddings/EmbeddingProviderFactory.ts` (Phase 3)
- Modify:
  - `smart-context-mcp/src/indexing/Migrations.ts` (schema_version 3+)
  - `smart-context-mcp/src/index.ts` (InternalToolRegistry에 `doc_*` 등록 + 핸들러 연결)
  - `smart-context-mcp/src/indexing/IncrementalIndexer.ts` (문서 변경 이벤트를 DocumentIndexer로 라우팅)
  - `smart-context-mcp/src/orchestration/pillars/ReadPillar.ts` (문서 view 처리)
  - `smart-context-mcp/src/orchestration/pillars/NavigatePillar.ts` (docs context 확장)
  - `smart-context-mcp/src/orchestration/pillars/UnderstandPillar.ts` (문서 goal 감지 시 doc_analyze)

### 16.2 Acceptance Criteria (Phase 1 완료 기준)

- `.md/.mdx`에 대해 `read(view="skeleton")`이 TOC 중심 skeleton을 반환한다.
- `doc_toc`/`doc_section` 내부 도구가 동작하고, 잘못된 section 식별자에 대해 명확한 에러/가이던스를 반환한다.
- 파일 변경 시(`chokidar change`) 문서 chunk 인덱스가 갱신되고, 삭제 시 cascade로 정리된다.

권장 검증 시나리오(수동):
- `.mdx` 파일에 heading/링크/JSX를 포함한 샘플을 만들고
  - `read(view="skeleton")`에서 TOC가 생성되는지 확인
  - `doc_section(headingPath=[...])`로 섹션 텍스트가 JSX 노이즈 없이 추출되는지 확인
- `.md` 파일 수정 후 재호출 시 `document_chunks.updated_at/content_hash`가 갱신되는지 확인

### 16.2.1 Error/Degradation 계약(Phase 1)

- 섹션을 못 찾으면:
  - `status: "no_results"` 또는 `success: false`
  - `suggestions`: 가장 가까운 headingPath 후보 3~5개를 포함(정규화 매칭 기반)
- WASM/파서 실패 시:
  - fallback 파서를 사용하고 `degraded: true`, `reason: "parser_fallback"`를 설정
  - skeleton/outline은 최소한 유지(heading만이라도)

### 16.3 Acceptance Criteria (Phase 3 완료 기준)

- provider=auto에서 OpenAI 키가 없으면 로컬 임베딩으로 폴백한다.
- lazy 생성 기본: 문서 전체 임베딩을 강제 생성하지 않고도 검색 요청에서 필요한 chunk만 임베딩한다.
- 하이브리드 검색 결과가 “파일”이 아니라 “섹션(chunk)” TopK로 반환된다.

### 16.4 Acceptance Criteria (Phase 2 완료 기준)

- `.md`에서 tree-sitter-markdown wasm이 로드되면 remark 대비 더 정확한 heading 경계를 제공한다.
- wasm 로딩 실패 시에도 즉시 hard-fail 하지 않고 remark로 폴백한다(`degraded: true`).
- `chunkId/sectionPath`가 “heading 기반”으로 안정적으로 유지되고, 동일 heading 내 순서 변화에도 가능한 한 재매핑된다(최소: old headingPath로 찾으면 가장 가까운 섹션으로 유도).

### 16.5 Rebuild/Sync 규칙(운영)

- `manage(command="rebuild")`:
  - 기존 코드 인덱스 rebuild와 함께 문서 인덱스도 rebuild한다(프로젝트 전체 `.md/.mdx`)
  - 임베딩 eager 생성은 `SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER=true`일 때만 수행(Phase 3)
- `manage(command="reindex")`:
  - 증분 인덱싱 상태 재동기화에 문서도 포함(큐 초기화 + 스냅샷 반영)

---

## 12. Dependencies & Build/Runtime Settings

### 12.1 Proposed Dependencies

- Markdown 파싱/메타:
  - `remark`(+ `remark-parse`) 또는 `unified`
  - `remark-mdx` (MDX)
  - `gray-matter` (frontmatter)
- 로컬 임베딩:
  - `@xenova/transformers`
- OpenAI 임베딩(옵션):
  - `openai` (optional dependency) 또는 직접 HTTP

### 12.2 Runtime Config (예시)

- `SMART_CONTEXT_WASM_DIR`: 커스텀 wasm 로드 경로(우선순위 1)
- `SMART_CONTEXT_EMBEDDING_PROVIDER=auto|openai|local|disabled`
- `OPENAI_API_KEY`(또는 `EmbeddingConfig.openai.apiKeyEnv`)
- `SMART_CONTEXT_EMBEDDING_MODEL_OPENAI`, `SMART_CONTEXT_EMBEDDING_MODEL_LOCAL`(선택)

---

## 13. Risks / Mitigations

- **WASM 빌드 실패/환경 제약**
  - Mitigation: remark 폴백(Phase 1 유지), `SMART_CONTEXT_WASM_DIR` 기반 배포 경로 단순화
- **임베딩 비용/네트워크 불가**
  - Mitigation: OpenAI 우선이지만 로컬 폴백 제공, provider=disabled 옵션 제공, chunk 캐싱으로 호출 최소화
- **DB 크기 증가**
  - Mitigation: chunk 크기 제한/압축(선택), 오래된 임베딩 prune, 모델별 1개 유지 정책
- **검색 지연(벡터 선형 스캔)**
  - Mitigation: 후보 제한(키워드/파일 후보), LRU 캐시, 이후 ANN/확장 도입은 별도 ADR
- **MDX 품질 불확실성**
  - Mitigation: `.md`를 권장 포맷으로 명세하고, `.mdx`는 호환성/편의 제공으로 정의(Phase 1에서는 JSX 노이즈 최소화 규칙 적용)
- **임베딩 로컬 부하(콜드스타트/CPU 점유)**
  - Mitigation: 7.1.3의 큐/동시성/예산 가드레일 + lazy 생성 기본
- **랭킹 튜닝 부담**
  - Mitigation: 7.3.2의 RRF 기본 + (옵션) TopK rerank로 “작은 영역만” 고도화
- **“무엇이 답인지” 충돌(문서 상충/중복)**
  - Mitigation: 아래 정책을 기본으로 채택(Phase 4)
    - 근거 기반 응답: 각 주장에 대응하는 섹션/경로를 함께 제시
    - 충돌 감지 시: “A 섹션 주장 vs B 섹션 주장” 형태로 논지를 병렬 제시하고, 선택 기준(최신성/권위/범위/적용 조건)을 요약
    - 최신성 신호: git mtime(또는 frontmatter date), ADR/README 등 “권위 있는 경로” 우선순위(휴리스틱)
 - **결과 다양성 부족(근거가 한 곳에 편중)**
   - Mitigation: 7.3.4의 MMR 기본 ON으로 TopK의 중복을 줄이고 근거 폭을 확장

---

## 14. Success Metrics

- 문서 질의 응답:
  - Top-3에 정답 섹션 포함 비율(정확도)
  - 문서 skeleton/section 응답의 P50/P95 latency
- 리소스/운영:
  - 임베딩 생성 비용(월별) 또는 로컬 실행 시간
  - DB 크기 증가량(프로젝트 규모 대비)
- UX:
  - 에이전트가 “문서→코드” 연결을 제안/실행하는 성공률(Phase 4)
  - 충돌/중복 문서 상황에서 “근거 섹션 2개 이상”을 함께 제시하는 비율(투명성)

---

## 15. Decisions & Open Questions

### 15.1 Confirmed Decisions

- MDX 텍스트 추출: 컴포넌트/props를 안전한 범위에서 보존(placeholder-only 지양)
- Chunking: heading + 표/리스트/코드펜스까지 고려하는 structural chunking 채택
- `read` 인터페이스: `sectionId/headingPath`를 정식 필드로 추가
- 인덱싱 트리거: watcher + `manage(rebuild/reindex)`에서 전체 프로젝트 `.md/.mdx` 강제 동기화 포함
- 임베딩 트리거: `doc_search` + `navigate/understand`까지 자동 확장(lazy 기본)
- 랭킹: RRF 기반 + OpenAI 가능 시 rerank + MMR 기본 ON
- 상충/중복: 항상 병렬 근거 제시(투명성 우선)
- MDX 파서: `.mdx`는 remark 기반으로 유지(tree-sitter mdx는 도입하지 않음)

### 15.2 Remaining Open Questions

- (Resolved) rerank 생략 시 근거 섹션 개수는 고정값이 아니라, `maxEvidence*` 상한 내에서 budget 기반으로 동적 확장
- (Future) ANN 도입 범위: 코퍼스 규모가 커질 때 플러그인 방식으로 FAISS/HNSW/ScaNN 같은 엔진을 붙일지, 선형 스캔을 고수할지?

---

## 17. Research Notes (Search / Review)

본 섹션은 “검색/검토 결과를 실제 설계에 반영”하기 위한 참고 자료 목록이며, Phase 3~4에서 도입 여부를 결정합니다.

### 17.1 Hybrid Fusion / Diversity

- **RRF (Reciprocal Rank Fusion)**: 하이브리드 결합 시 점수 정규화 문제를 회피하기 위해 “랭크 기반”으로 합성.
- **MMR (Maximal Marginal Relevance)**: TopK가 한 문서/한 섹션에 쏠릴 때 중복을 줄이기 위한 diversity rerank.

### 17.2 Learned Sparse / Late Interaction (선택 옵션)

- **SPLADE**: inverted index 친화적인 sparse 표현(lexical expansion)으로 BM25의 vocabulary mismatch를 줄이되, 계산 비용이 큼.
- **ColBERTv2**: late interaction 기반으로 품질-효율 트레이드오프가 좋지만, multi-vector 인덱싱/저장 복잡도가 큼.

### 17.3 ANN Engines (Future / Plug-in)

프로젝트 문서 수가 “수만~수십만”을 넘어가거나, 로컬 임베딩 검색이 병목이 될 경우를 대비해 플러그인 형태로 고려합니다.

- **FAISS (Meta)**: 다양한 ANN 인덱스(IVF/PQ/HNSW 등) + GPU 최적화.
- **HNSW**: 그래프 기반 ANN의 사실상 표준 중 하나(메모리↑, 품질↑).
- **ScaNN (Google)**: pruning + quantization 계열로 대규모 벡터 검색을 가속.

### 17.4 Practical Reference Links

아래 링크들은 “알고리즘/운영 패턴”의 근거로만 사용하며, 본 프로젝트에 그대로 도입한다는 의미는 아닙니다.

```text
RRF (SIGIR 2009) — Google Research publication page
https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/

RRF reference (SIGIR 2009) — IR Anthology entry (DOI 포함)
https://ir.webis.de/anthology/2009.sigirconf_conference-2009.146/

MMR (1998) — ACL Anthology (TIPSTER workshop, PDF 제공)
https://aclanthology.org/X98-1025/

MonoT5 / Seq2Seq reranking (2020) — arXiv
https://arxiv.org/abs/2003.06713

SPLADE v2 (2021) — arXiv
https://arxiv.org/abs/2109.10086

SPLADE v2 (Naver Labs) — official repo
https://github.com/naver/splade

ColBERTv2 (2022) — ACL Anthology
https://aclanthology.org/2022.naacl-main.272/

Vespa reciprocal_rank_fusion() / phased ranking docs
https://docs.vespa.ai/en/ranking/phased-ranking.html

FAISS 소개 (Meta Engineering blog)
https://engineering.fb.com/2017/03/29/data-infrastructure/faiss-a-library-for-efficient-similarity-search/

ScaNN — Google Research blog (SOAR announcement / background)
https://research.google/blog/announcing-scann-efficient-vector-similarity-search/

ScaNN — GitHub (source of truth for implementation)
https://github.com/google-research/google-research/tree/master/scann
```
