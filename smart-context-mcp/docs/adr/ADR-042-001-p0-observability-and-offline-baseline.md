# ADR-042-001: P0 Observability + Standalone Baseline (No Network / No Native DB)

**Status:** Proposed  
**Date:** 2026-01-02  
**Author:** Smart Context MCP Team  
**Related:** `docs/analysis/technical-report.md`, ADR-034/035 (Budgets & Degradation), ADR-036~039 (Document pipeline), ADR-041 (Integrity modes)

---

## 1. 배경 (Context)

`Smart Context MCP`의 현재 병목/리스크는 “정확한 수치 없이 추정만 하는 상태”와 “외부 의존(네트워크/네이티브 바인딩)로 인해 기본 동작이 깨질 수 있는 상태”가 결합된 형태입니다.

`docs/analysis/technical-report.md`의 P0는 이를 다음 두 축으로 요약합니다.

1) **벤치/계측으로 병목을 수치화**: p50/p95/p99 지연, 메모리, (standalone) 저장소 I/O, 임베딩 큐 등 “지금 무엇이 느린지”를 측정 가능하게 만들기  
2) **폐쇄(오프라인) 환경에서도 최대 성능으로 동작**: 네트워크/원격 API 없이, 네이티브 DB 없이도 서버가 단독 모드로 “시작”하고 최대 성능을 낼 수 있도록 내부 로직을 최적화한다.

현재 코드베이스 상태는 다음과 같습니다.

- 벤치마크는 존재하나(`benchmarks/main.ts`) **퍼센타일/분포 지표**가 아닌 1회 측정 중심입니다.
- 런타임 메트릭은 `src/utils/MetricsCollector.ts`에 counter/gauge만 있고, **latency histogram/percentiles**가 없습니다.
- 문서 인덱싱/임베딩 저장소가 `better-sqlite3`(네이티브) 기반인 구간이 있어, 빌드/플랫폼 제약이 생기면 **프로세스 자체가 시작하지 못할 가능성**이 있습니다.
- 임베딩은 **원격 API(Online)를 사용하지 않는다.** 플랫폼 이식성과 재현성을 위해 “가성비 좋은 로컬 모델”을 프로젝트에 **온전히 이식(번들링)해 내장**하고, 실패 시 `HashEmbeddingProvider` 또는 `disabled`로 degrade 한다.

---

## 2. 목표 / 비목표 (Goals / Non-Goals)

### Goals (P0)

1) **측정 가능성 확보**
   - 검색/인덱싱/문서검색/임베딩의 주요 단계별 latency 분포(p50/p95/p99)를 산출할 수 있다.
   - 메모리(RSS/heap), 임베딩 큐 깊이, 인덱싱 큐/대기열 등을 관측할 수 있다.
   - MCP 호스트 환경에서도 stdout 오염 없이(기본은 파일/관리 커맨드) 확인 가능하다.

2) **Standalone 기본 동작(폐쇄 환경)**
   - 네트워크가 차단된 환경에서도 서버가 “시작”하고, 핵심 기능(코드 검색/읽기/요약/변경 플로우의 최소치)이 작동한다.
   - 임베딩은 로컬 내장 모델을 기본으로 사용하며, 모델 로딩 실패 시 안전하게 degrade 한다(예: hash/disabled).
   - **네이티브 DB 의존을 제거**하고, `smart-context-mcp` 단독 모드에서 순수 Node/FS 기반 저장소로 동작한다(성능상 치명적이지 않은 범위에서 최적화).

3) **degradation 계약 명시**
   - 시간이 초과되거나(임베딩/인덱싱), 백엔드가 unavailable 한 경우, 응답에 `degraded: true`와 이유(reasons)를 명확히 포함한다.

### Non-Goals (P0 범위 밖)

- ANN 도입(HNSW/FAISS/ScaNN), PQ/양자화, GPU/분산 등은 P1/P2 범위로 미룬다.
- “범용 DB/쿼리 엔진” 수준의 대규모 리팩터링은 하지 않는다(필요 연산만 제공하는 `IndexStore` 범위로 제한).
- SQLite/외부 DB 플러그인까지 포함한 다중 백엔드 지원은 P0 범위 밖이다(네이티브 DB 제거가 우선).

---

## 3. 결정 (Decision)

P0로 다음 3가지 변경을 채택합니다.

1) **Metrics v1.1 도입**: counter/gauge에 더해 **timer + histogram(샘플 기반)** 을 추가하고, 핵심 경로에 계측을 삽입한다.  
2) **Remote Embedding 제거 + Bundled Local Embeddings**: 원격 임베딩(Online)을 완전히 제거하고, `multilingual-e5-small`을 번들링하여 기본 임베딩으로 사용한다(실패 시 hash/disabled).  
3) **Native DB 제거 + Standalone Storage v0**: `better-sqlite3`(네이티브 DB)를 제거하고, 순수 Node/FS 기반 저장소로 동작하도록 전환한다(필요 시 in-memory + 파일 스냅샷).

---

## 4. 상세 설계 (개발 착수 가능한 수준)

### 4.1 구성 옵션(ENV) 추가

| Variable | Default | Purpose |
|---|---:|---|
| `SMART_CONTEXT_METRICS_MODE` | `basic` | `off \| basic \| detailed` |
| `SMART_CONTEXT_METRICS_HIST_MAX_SAMPLES` | `1024` | histogram 샘플(리저버) 최대 크기 |
| `SMART_CONTEXT_STORAGE_MODE` | `file` | `file \| memory` (네이티브 DB 없음) |
| `SMART_CONTEXT_EMBEDDING_PROVIDER` | `local` | `local \| hash \| disabled` (원격 provider 없음) |
| `SMART_CONTEXT_EMBEDDING_MODEL` | `bundled:multilingual-e5-small` | 내장 모델 식별자 |
| `SMART_CONTEXT_MODEL_DIR` | *(unset)* | 번들/모델 파일 위치(절대 또는 프로젝트 상대 경로) |
| `SMART_CONTEXT_EMBEDDING_E5_PREFIX` | `true` | E5 접두어(`query:`/`passage:`) 적용 여부 |

Embedding provider 규칙:

- 기본은 `local`이며, 모델은 `bundled`를 우선 사용한다.
- 모델 로딩 실패/불가 환경에서는 `hash`로 degrade(개발/테스트/CI 친화).
- 원격 다운로드 없이 동작하도록 번들 모델은 패키지에 포함되어야 한다.

E5 접두어 규칙(기본 활성화):

- Query 임베딩 입력: `query: ${text}`
- Chunk/문서 임베딩 입력: `passage: ${text}`

Storage mode 규칙:

- `SMART_CONTEXT_STORAGE_MODE=file`: `.smart-context/` 하위 파일 기반 저장소(standalone 기본)
- `SMART_CONTEXT_STORAGE_MODE=memory`: 영속성 없이 in-memory 우선(최대 성능/벤치/테스트용)

### 4.1.1 (확정) Transformers.js 로컬 번들 로딩 가능 여부

`@xenova/transformers`는 설정만으로 “원격 모델 로딩을 완전히 차단”하고 “로컬 모델 경로에서만” 모델 파일을 로드할 수 있습니다.

- `env.allowRemoteModels = false`로 원격 로딩을 금지할 수 있음
- `env.localModelPath = <로컬 모델 루트>`로 로컬 모델 루트를 지정할 수 있음
- 기대 동작: 모델 파일이 로컬에 없으면 즉시 에러(원격 다운로드 시도 없음) → 폐쇄망/에어갭 환경에서 재현성 확보

> 따라서 P0 구현은 “모델을 패키지에 vendor(ONNX + tokenizer)로 포함”하고, 런타임에서 `env.allowRemoteModels=false`를 강제하는 방식으로 착수 가능합니다.

### 4.2 MetricsCollector 확장 (Histogram + Timer)

현 `src/utils/MetricsCollector.ts`는 counter/gauge만 제공합니다. 이를 다음과 같이 확장합니다.

#### API (개념)

```ts
metrics.inc("name", 1);
metrics.gauge("name", value);
metrics.observe("name", value); // histogram sample (e.g., ms)

const end = metrics.startTimer("search.scout.total_ms");
try { ... } finally { end(); }

metrics.snapshot(); // counters/gauges + percentiles
```

#### Histogram 구현 요구사항

- 고정 크기(`SMART_CONTEXT_METRICS_HIST_MAX_SAMPLES`)의 샘플 저장(예: ring buffer 또는 reservoir)
- snapshot 시 p50/p95/p99, count, min/max, mean 산출
- `basic` 모드에서는 주요 경로만, `detailed`에서는 단계별 세분화 메트릭까지 수집

> 주의: MCP 서버는 장시간 실행되므로 histogram이 무한 증가하지 않도록 “bounded”여야 합니다.

### 4.3 계측 포인트(Instrumentation Map)

최소 계측 포인트(필수):

1) **Search**
   - `search.scout.total_ms`
   - `search.scout.collect_candidates_ms`
   - `search.scout.read_files_ms`
   - `search.scout.rank_bm25_ms`
   - `search.scout.hybrid_score_ms`
   - `search.scout.results_count` (gauge)

2) **Indexing**
   - `indexer.initial_scan_ms`
   - `indexer.incremental_scan_ms`
   - `indexer.queue_depth` (이미 존재: 유지/표준화)
   - `indexer.files_indexed_total` (counter)

3) **Documents**
   - `docs.search.total_ms`
   - `docs.search.candidate_files` (gauge)
   - `docs.search.candidate_chunks` (gauge)
   - `docs.search.embedding_query_ms`
   - `docs.search.embedding_chunks_ms`
   - `docs.search.vector_scoring_ms`
   - `docs.search.degraded_total` (counter, reason별은 suffix로 분리하거나 별도 counter)

4) **Embeddings**
   - `embeddings.queue_depth` (gauge)
   - `embeddings.queue_timeouts_total` (counter)
   - `embeddings.provider` (gauge 또는 meta: provider/model)

5) **Process**
   - `process.rss_bytes`, `process.heap_used_bytes` (gauge; snapshot 시 갱신)

### 4.4 벤치마크(benchmarks) 개선

`benchmarks/main.ts`를 P0 기준에 맞게 보강합니다.

- 단일 측정 → **N회 반복 측정 + p50/p95/p99 산출**
- 측정 대상: 최소한 아래 3개는 분포가 나오도록 구성
  - Cold start + initial scan
  - Search (대표 쿼리 세트 20~50개)
  - Document search (embedding on/off 비교)
- CI/재현성 친화 기본값:
  - 벤치는 기본적으로 `SMART_CONTEXT_EMBEDDING_PROVIDER=hash`(또는 `local` + bundled)로 네트워크 없는 실행을 보장

출력:

- 기존 Markdown report 유지 + percentiles 테이블 추가
- (옵션) JSON report로도 저장해 추세 비교 가능하게 한다

### 4.4.1 (확정) P0 성능 기준(목표치) — 폐쇄 환경 최대 성능

P0의 성능 기준은 “폐쇄 환경에서 네트워크/네이티브 DB 없이도 최대 성능을 낸다”를 검증하기 위한 최소 목표치입니다.
벤치/메트릭은 **평균이 아니라 p95 중심**으로 관리합니다.

**기본 벤치 세팅(권장)**

- `SMART_CONTEXT_STORAGE_MODE=memory` (최대 성능 기준선)
- `SMART_CONTEXT_EMBEDDING_PROVIDER=hash` (모델 준비 전/CI에서 재현성 확보)

**standalone+번들 세팅(필수 검증)**

- `SMART_CONTEXT_STORAGE_MODE=file` (standalone 기본)
- `SMART_CONTEXT_EMBEDDING_PROVIDER=local`
- `SMART_CONTEXT_EMBEDDING_MODEL=bundled:multilingual-e5-small`
- `SMART_CONTEXT_EMBEDDING_E5_PREFIX=true`

**목표치(초기)**

- Cold start (500 files): p95 < 500ms
- Incremental scan: p95 < 50ms
- Skeleton gen (large file): p95 < 30ms
- Search Recall@1: > 90% (샘플 쿼리 세트 기준)
- Doc search latency (no vector / hash): p95 < 150ms (소형 샘플 기준)
- (추가) Standalone storage:
  - Snapshot load(메타+청크 인덱스): p95 < 300ms (소형 샘플 기준)
  - Per-file chunk write: p95 < 20ms (문서 1개 기준)

> 위 목표치는 `benchmarks/README.md`의 기존 기준과 정합하게 시작하고, 실제 측정값(레포 크기/OS/Node 버전)을 축적한 뒤 조정합니다.

### 4.5 Bundled-First 임베딩 실행 모델

내장 임베딩은 “기능을 빼는 것”이 아니라 “**명시적으로 degrade 계약을 제공**”하는 것입니다.

#### 폐쇄 환경에서 보장할 최소 기능(MVP)

- 파일 기반 검색(Trigram/BM25 기반) 및 파일 읽기/프리뷰/스켈레톤
- change 트랜잭션(기존 로직) 및 undo/redo
- 문서 검색은 임베딩 없이도 keyword 기반으로 동작(이미 `SearchEngine` 기반 후보 수집이 존재)

#### 임베딩 처리 규칙(원격 제거 + E5 접두어)

- 원격 provider는 존재하지 않는다(제거 대상).
- 기본은 `multilingual-e5-small` bundled model을 로드한다.
- `SMART_CONTEXT_EMBEDDING_E5_PREFIX=true`인 경우 query/chunk에 접두어를 적용한다.
- 로딩 실패 시 `HashEmbeddingProvider` 또는 `DisabledEmbeddingProvider`로 degrade 한다.

#### 번들 모델 파일 레이아웃(확정)

런타임 다운로드 없이 로드하기 위해, 번들 모델은 아래 형태로 패키지에 포함되어야 합니다(ONNX + tokenizer).

예시(모델 루트 = `SMART_CONTEXT_MODEL_DIR`, 또는 기본 경로):

```
multilingual-e5-small/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    ├── model.onnx
    └── model_quantized.onnx   (권장: 크기/성능 균형)
```

#### 번들 배포 방식(확정: 레포 미포함, 패키지/릴리즈 포함)

- 모델 파일은 **git에 커밋하지 않는다**(레포 용량/clone 부담 방지).
- 대신 **npm 패키지/릴리즈 산출물에 포함**한다(폐쇄 환경에서 “추가 다운로드 없이” 즉시 실행).
- 개발(레포) 환경에서는:
  - 기본적으로 원격 모델 로딩을 차단(`env.allowRemoteModels=false`)하므로,
  - 로컬에서 실행/테스트하려면 별도 “모델 준비 스크립트(prepack/prepare)”로 `SMART_CONTEXT_MODEL_DIR`에 모델을 배치해야 한다.
- 패키지 내부 경로는 `SMART_CONTEXT_MODEL_DIR` 기본값으로 해석 가능해야 한다(예: `dist/models/` 또는 `models/`).

응답 표준:

- 임베딩이 비활성화되면 `vectorEnabled=false`, `degraded=true`, `reasons=["vector_disabled" | "embedding_timeout" | ...]`를 포함한다.

### 4.6 Native DB 제거 + Standalone Storage v0

#### 목표

- `better-sqlite3`를 포함한 **네이티브 DB 의존을 제거**한다.
- 폐쇄 환경에서 “설치/빌드 실패” 없이 실행되며, 성능상 치명적이지 않은 범위에서 **내부 로직 최적화로 최대 성능**을 낸다.

#### 설계 개요(Storage v0)

P0에서는 “DB 대체”를 범용 DB 수준으로 만들지 않고, `smart-context-mcp`의 사용 패턴에 맞춘 **standalone 저장소**로 제한합니다.

- 기본 모드: `SMART_CONTEXT_STORAGE_MODE=file`
  - `.smart-context/` 하위에 **파일 기반 스냅샷**을 저장한다.
- 고성능/벤치 모드: `SMART_CONTEXT_STORAGE_MODE=memory`
  - 디스크 I/O 없이 in-memory로 동작(재시작 시 재색인)

#### 데이터 구분(권장)

1) **Hot(항상 메모리)**: 검색 인덱스(트라이그램/BM25 보조), 최근 결과 캐시, 작업 큐 상태  
2) **Warm(파일 스냅샷)**: 문서 청크, 임베딩 벡터, evidence pack, 트랜잭션/히스토리(undo/redo)  
3) **Cold(필요 시 재생성)**: 파생 데이터(예: 요약 캐시), 일시적 분석 결과

#### (확정) P0에서 “저장해야 하는 것 / 재생성해도 되는 것”

P0의 최종 목표가 “폐쇄 환경 최대 성능”이므로, 아래는 P0 범위에서 저장소(v0)가 반드시 커버해야 하는 최소 단위입니다.

- **필수(기능/성능에 직접 영향)**:
  - 문서 청크(`DocumentIndexer` 산출물) — 재파싱 비용 절감
  - 임베딩 벡터(청크 단위) — 가장 비싼 계산 비용 절감
  - 파일 메타(ctime/mtime/size/contentHash) — 증분 갱신/스냅샷 신뢰도 확보
  - 트랜잭션/히스토리(undo/redo 및 pending 복구) — 변경 신뢰성 유지
- **권장(있으면 UX/효율 상승)**:
  - evidence packs — 반복 탐색에서 토큰/IO 절감
  - 심볼 인덱스 스냅샷 — cold start/첫 쿼리 지연 감소(특히 `SymbolIndex.search`)
  - 의존성 그래프 스냅샷 — `understand`/impact 분석 가속
- **재생성 가능(P0에서는 optional)**:
  - 요약 캐시(Deterministic summary) — 필요 시 재계산 가능
  - 각종 파생 통계(핫스팟, 랭킹 피쳐 등) — 계측 기반으로 후속 최적화

#### 파일 레이아웃(v0 예시)

`SMART_CONTEXT_DIR`(기본 `.smart-context/`) 하위:

- `storage/manifest.json` (버전/스키마/마이그레이션)
- `storage/files.jsonl` (파일 메타: path, mtime, size, contentHash)
- `storage/chunks/<fileHash>.json` (문서 청크 단위 스냅샷; 파일 단위 분할로 partial rewrite)
- `storage/embeddings/<provider>/<model>/<fileHash>.f32` (벡터 BLOB; 파일 단위 분할)
- `storage/embeddings/<provider>/<model>/<fileHash>.index.json` (chunkId → offset/len)
- `storage/packs/<packId>.json` (evidence pack)
- `storage/tx/history.jsonl` (transaction/undo/redo 로그)

> v0는 구현 복잡도를 낮추기 위해 “파일 단위 분할 + 원자적 쓰기(임시 파일 → rename)”를 기본으로 합니다.

#### 성능 원칙(P0)

- “핫 경로”는 메모리에 유지하고, 디스크 저장은 **배치/스냅샷**으로 amortize 한다.
- 임베딩/청크는 **파일 단위 분할**로 바꿔서, 변경된 파일만 재계산/재저장한다.
- 벡터 저장은 `Float32Array`를 그대로 바이너리로 유지하여 encode/decode 비용을 최소화한다.
  - 검색 시에는 필요한 파일/청크만 로드하고, 나머지는 lazy-load 한다.

#### (확정) 스토리지 경계(API) — “DB 대체”가 아니라 “Index Store”

P0에서는 범용 DB를 만들지 않고, 현재 코드 경로가 실제로 필요로 하는 연산을 직접 지원하는 `IndexStore` 경계를 둡니다.

- 핵심 원칙:
  - “SQL 질의”가 아니라 “필요한 연산 메서드”를 제공한다.
  - `memory`/`file` 두 구현이 동일 인터페이스를 만족한다.
  - 원자적 쓰기(`.tmp` → `rename`)로 크래시/중단에도 스냅샷이 깨지지 않게 한다.

P0에서 최소로 필요한 인터페이스(초안):

```ts
export type StorageMode = "memory" | "file";

export type FileMeta = {
  path: string;              // normalized relative path
  lastModified: number;      // mtimeMs
  language?: string | null;
  sizeBytes?: number;
  contentHash?: string;
};

export type StoredSymbolRow = { name: string; data: unknown };
export type StoredDependency = { source: string; target: string; type: string; weight: number; metadata?: Record<string, unknown> };

export interface IndexStore {
  mode: StorageMode;

  // Files
  upsertFile(meta: FileMeta): FileMeta;
  getFile(path: string): FileMeta | undefined;
  listFiles(): FileMeta[];
  deleteFile(path: string): void;
  deleteFilesByPrefix(prefix: string): void;

  // Symbols
  replaceSymbols(path: string, symbols: StoredSymbolRow[], meta?: { lastModified?: number; language?: string | null }): void;
  readSymbols(path: string): unknown[] | undefined;
  searchSymbolsContains(query: string, limit: number): Array<{ path: string; data: unknown }>;

  // Dependencies (file-to-file)
  replaceDependencies(path: string, outgoing: StoredDependency[], unresolved: Array<{ specifier: string; error?: string; metadata?: Record<string, unknown> }>): void;
  getDependencies(path: string, direction: "incoming" | "outgoing"): StoredDependency[];
  countDependencies(path: string, direction: "incoming" | "outgoing"): number;
  listUnresolved(): Array<{ filePath: string; specifier: string; error?: string; metadata?: Record<string, unknown> }>;
  listUnresolvedForFile(path: string): Array<{ specifier: string; error?: string; metadata?: Record<string, unknown> }>;

  // Ghost registry (deleted-but-referenced symbols)
  addGhost(ghost: { name: string; lastSeenPath: string; type: string; lastKnownSignature?: string | null; deletedAt: number }): void;
  findGhost(name: string): any | null;
  listGhosts(): any[];
  deleteGhost(name: string): void;
  pruneGhosts(olderThanMs: number): void;

  // Docs / embeddings / packs
  upsertDocumentChunks(filePath: string, chunks: Array<{ id: string; kind: string; sectionPath: string[]; heading?: string | null; headingLevel?: number | null; range: any; text: string; contentHash: string; updatedAt: number }>): void;
  listDocumentChunks(filePath: string): any[];
  listDocumentFiles(limit: number): string[];
  getChunkContentHash(chunkId: string): string | undefined;
  deleteDocumentChunks(filePath: string): void;

  upsertEmbedding(chunkId: string, key: { provider: string; model: string }, embedding: { dims: number; vector: Float32Array; norm?: number }): void;
  getEmbedding(chunkId: string, key: { provider: string; model: string }): { dims: number; vector: Float32Array; norm?: number } | null;
  deleteEmbeddingsForFile(filePath: string): void;

  upsertEvidencePack(packId: string, payload: unknown): void;
  getEvidencePack(packId: string): unknown | null;

  // Transactions (pending recovery)
  upsertPendingTransaction(id: string, payload: unknown): void;
  listPendingTransactions(): unknown[];
  markTransactionCommitted(id: string, payload: unknown): void;
  markTransactionRolledBack(id: string): void;

  close(): void;
}
```

> 구현 착수 시에는 위 인터페이스를 현재 `IndexDatabase`/repositories 호출 패턴에 맞춰 “정확히 필요한 메서드만”으로 더 다듬고(삭제/축소 가능), `file` 구현은 파일 레이아웃(v0)을 사용합니다.

#### (확정) 영향 범위(치환 대상) — 네이티브 DB 제거 체크리스트

`better-sqlite3` 제거는 “라이브러리 교체”가 아니라 “저장소 경계 재정의”이므로, 아래 모듈들이 `IndexStore` 기반으로 치환되어야 합니다.

- `src/index.ts` — `IndexDatabase`, `DocumentChunkRepository`, `EmbeddingRepository`, `EvidencePackRepository`, `TransactionLog` 초기화 경로
- `src/indexing/IndexDatabase.ts` — 삭제/대체(네이티브 DB 제거)
- `src/indexing/MigrationRunner.ts`, `src/indexing/Migrations.ts` — 삭제(스키마/마이그레이션 제거)
- `src/indexing/DocumentChunkRepository.ts` — `IndexStore` 기반으로 재구현
- `src/indexing/EmbeddingRepository.ts` — `IndexStore` 기반으로 재구현
- `src/indexing/EvidencePackRepository.ts` — `IndexStore` 기반으로 재구현(요약 캐시는 optional)
- `src/engine/TransactionLog.ts` — 파일/메모리 기반으로 재구현(`pending` 복구 포함)
- `src/ast/SymbolIndex.ts`, `src/ast/DependencyGraph.ts` — `IndexDatabase` 의존 제거(심볼/의존성 저장을 `IndexStore`로 이동)

### 4.7 운영/진단 노출 (manage_project 확장)

`manage_project`에 다음 커맨드를 추가합니다.

- `metrics`: 현재 metrics snapshot 반환
- `metrics_reset`: (선택) counters/histograms 초기화
- `config`: (선택) 주요 런타임 설정/모드(storage/embedding/standalone) 요약 반환

응답 예시(개념):

```json
{
  "success": true,
  "metrics": {
    "counters": { "docs.search.degraded_total": 3 },
    "gauges": { "indexer.queue_depth": 0, "process.rss_bytes": 123456789 },
    "histograms": {
      "search.scout.total_ms": { "count": 120, "p50": 18.2, "p95": 72.1, "p99": 110.4 }
    }
  }
}
```

---

## 5. 단계별 구현 계획 (Implementation Plan)

### Step 1 — MetricsCollector v1.1 + 핵심 계측 (1~3일)

- `src/utils/MetricsCollector.ts` 확장(히스토그램/타이머)
- Search/Docs/Indexing/Embeddings 주요 경로에 `metrics.startTimer/observe` 삽입
- `SMART_CONTEXT_METRICS_MODE`로 오버헤드 제어

### Step 2 — manage_project metrics 노출 (0.5~1일)

- `src/index.ts`의 `manage_project`에 `metrics` 커맨드 추가
- 스토리지/임베딩/standalone 모드 요약(선택)

### Step 3 — Remote Embedding 제거 + Bundled Model 도입(임베딩) (2~6일)

- `OpenAIEmbeddingProvider` 및 관련 env/config 제거(또는 deprecate → 제거)
- `multilingual-e5-small` 번들링(런타임 다운로드 없이 로드)
- E5 접두어(`query:`/`passage:`) 규칙 적용
- 번들 배포: 모델은 레포에 커밋하지 않고, npm 패키지/릴리즈 산출물에 포함(prepack 단계에서 `SMART_CONTEXT_MODEL_DIR`로 복사/정리)
- 번들 모델 로딩 실패 시 `hash/disabled` degrade
- 문서 검색 응답에 `vectorEnabled/degraded/reasons` 표준화(이미 일부 존재하므로 정리 중심)

### Step 4 — Native DB 제거 + Standalone Storage v0 (4~10일)

- `better-sqlite3` 직접 import 제거(영향 범위: indexing/* repository들, tx/history 등)
- `SMART_CONTEXT_STORAGE_MODE=file|memory` 구현
- 파일 레이아웃(v0) 기준으로 chunks/embeddings/packs/history 저장 구현
- “standalone storage” 성능 측정(bench + metrics) 및 병목 최적화

---

## 6. 고려한 대안 (Alternatives)

1) **OpenTelemetry(OTel) 즉시 도입**
   - Pros: 표준, 연동 풍부
   - Cons: 도입/설정 비용 증가, MCP 호스트/로컬 환경에서 운영 난도 상승
   - 결론: P0는 내부 bounded metrics로 시작하고, 필요 시 P1에서 OTel bridge를 추가

2) **벡터 DB/외부 서비스로 즉시 전환**
   - Pros: 성능/확장성 빠르게 확보 가능
   - Cons: 외부 의존 증가(P0 목표와 충돌), 비용/운영 부담
   - 결론: P0 범위 밖

3) **DB 추상화(플러그인) 전체 구현**
   - Pros: 장기적 확장성
   - Cons: 리팩터링 범위 큼
   - 결론: P0는 “standalone storage(v0) + 핵심 성능 최적화”로 제한

---

## 7. 리스크 및 완화 (Risks & Mitigations)

- **메트릭 오버헤드/메모리 증가**: histogram bounded + 모드(basic/detailed/off) 제공
- **MCP stdout 오염**: 기본은 manage_project/파일 로그 중심, stdout은 opt-in 유지
- **degrade 모드의 기능 불일치**: 최소 기능 정의(MVP) + 응답에 `degraded/reasons`를 강제
- **저장소 구현 범위 증가**: v0는 파일 단위 스냅샷으로 단순화하고, 성능 병목이 확인되면 이후 단계에서 포맷/인덱스 고도화
- **번들 모델 크기 증가**: quantized ONNX/WASM 옵션 사용 + 모델 1종 고정(multilingual-e5-small)

---

## 8. 성공 기준 (Acceptance Criteria)

1) `manage_project metrics`로 주요 latency percentile(p50/p95/p99)이 확인된다.  
2) 네트워크 없이 서버가 시작하고, 검색/읽기/변경 플로우가 동작한다.  
3) 원격 임베딩(Online) 경로가 코드베이스에서 제거되고, 번들 모델(`multilingual-e5-small`)로 임베딩이 동작한다(E5 접두어 포함).  
4) 네이티브 DB(`better-sqlite3`) 없이도 서버가 시작하고, `SMART_CONTEXT_STORAGE_MODE=file|memory`로 동작한다.  
5) 문서 검색/임베딩 경로는 실패 시 `degraded/reasons`를 일관되게 제공한다.
