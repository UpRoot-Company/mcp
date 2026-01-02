# ADR-042-002: P1 Hybrid ANN + Search Scaling (Offline-First)

**Status:** Accepted  
**Date:** 2026-01-03  
**Author:** Smart Context MCP Team  
**Related:** `docs/analysis/technical-report.md`, ADR-042-001 (P0 Offline Baseline), ADR-034/035 (Budgets & Degradation)

---

## 1. 배경 (Context)

P0에서 **오프라인/무네이티브 기준선**을 확보했습니다.

- 네트워크/원격 모델 제거 + 번들 로컬 임베딩
- 네이티브 DB 제거 → 파일 기반 저장소(IndexStore) 전환
- metrics/bench 보강

이제 병목의 중심은 **임베딩 유사도 검색의 확장성**입니다.  
현 상태의 문서 검색은 `BM25 → 후보 → 벡터 점수` 순으로 진행되며, 벡터 점수는 **사실상 선형 스캔**에 가깝습니다.  
또한 `TrigramIndex`는 대규모 레포에서 **메모리 사용량이 급격히 증가**할 수 있습니다.

따라서 P1은 **오프라인/이식성 유지**를 전제로, 벡터 검색의 확장성과 트라이그램 메모리 관리에 집중합니다.

---

## 2. P1 재선정 (Scope)

현재 패치 상태(P0 완료)를 반영한 P1 우선순위는 다음과 같습니다.

1) **ANN PoC + Hybrid 검색 파이프라인 연결**  
   - 10k~50k 임베딩 샘플에서 ANN 성능/정확도/지연을 검증
   - BM25/trigram → ANN 후보 → re-rank(RRF/MMR)로 연결

2) **Vector Index Persistence + 재빌드 흐름 정의**  
   - offline-first 상태에서 **재시작/재현 가능**해야 함
   - IndexStore 기반의 파일 레이아웃으로 통합

3) **Trigram 메모리 가드레일**  
   - 고빈도 트라이그램 필터링 및 per-file 상한
   - large repo에서 메모리 상한을 제어

---

## 3. 목표 / 비목표 (Goals / Non-Goals)

### Goals (P1)

1) **ANN 기반 벡터 검색 경로 확보**
   - 기본 오프라인 환경에서 ANN 인덱스 로드/검색이 가능해야 한다.
   - ANN 미사용/불가 시 기존 brute-force 경로로 자동 degrade.

2) **Hybrid 파이프라인 표준화**
   - BM25/trigram 결과와 ANN 결과를 RRF/MMR로 결합한다.

3) **Vector Index 재현성**
   - 파일 기반 인덱스로 저장/복구 가능한 형태.

4) **Trigram 메모리 제어**
   - 환경 변수 기반 상한/필터로 메모리 예측 가능성 확보.

### Non-Goals (P1 범위 밖)

- GPU/분산/FAISS 대규모 배포
- PQ/OPQ/압축 전략 대규모 튜닝
- 원격 벡터 DB 도입
- 완전한 동적 업데이트 보장(초기 PoC는 rebuild 또는 제한적 upsert 중심)

---

## 4. 결정 (Decision)

P1은 다음을 채택한다.

1) **VectorIndex 추상화 도입**  
   - `bruteforce` + `hnsw (WASM)` 2가지 백엔드
   - 기본은 `auto`(ANN 사용 가능할 때만 사용, 미사용 시 brute-force)

2) **ANN 백엔드: `hnsw` (optional module + fallback)**
   - 목표: 네이티브 빌드 없이 동작하는 ANN(또는 ANN 유사 경로)을 제공
   - 오프라인 환경에서 모델/인덱스 모두 로컬 로드 가능
   - ANN 모듈이 사용 불가한 환경에서는 **persisted brute-force 인덱스**로 자동 degrade(기능은 유지, 성능은 제한)

3) **Vector Index persistence 도입**  
   - `.smart-context/vector-index/<provider>/<model>/`에 저장
   - meta에 dims/버전/빌드 파라미터/루트 fingerprint를 기록

4) **DocumentSearchEngine에 hybrid 파이프라인 추가**  
   - BM25/trigram 후보 + ANN 후보 → RRF/MMR 결합

5) **Trigram 가드레일 추가**  
   - 고빈도 트라이그램 제거 + per-file 상한 옵션 추가

---

## 5. 상세 설계 (개발 착수 가능한 수준)

### 5.1 구성 옵션(ENV)

| Variable | Default | Purpose |
|---|---:|---|
| `SMART_CONTEXT_VECTOR_INDEX` | `auto` | `auto \| off \| bruteforce \| hnsw` |
| `SMART_CONTEXT_VECTOR_INDEX_REBUILD` | `auto` | `auto \| on_start \| manual` |
| `SMART_CONTEXT_VECTOR_INDEX_MAX_POINTS` | `200000` | 인덱스 최대 포인트 수 |
| `SMART_CONTEXT_VECTOR_INDEX_M` | `16` | HNSW M |
| `SMART_CONTEXT_VECTOR_INDEX_EF_CONSTRUCTION` | `200` | HNSW build 파라미터 |
| `SMART_CONTEXT_VECTOR_INDEX_EF_SEARCH` | `64` | HNSW search 파라미터 |
| `SMART_CONTEXT_TRIGRAM_MAX_DOC_FREQ` | `0.35` | 문서 비율 기준 상한(0~1) |
| `SMART_CONTEXT_TRIGRAM_MAX_TERMS_PER_FILE` | `6000` | 파일 단위 저장 상한 |

> `auto`는 ANN 인덱스 파일이 있고 로드 성공 시 ANN, 아니면 brute-force로 degrade한다.  
> `SMART_CONTEXT_VECTOR_INDEX_REBUILD`는 지정하지 않아도 된다(기본 `auto`).

### 5.2 VectorIndex 인터페이스

```ts
export interface VectorIndex {
  backend: "bruteforce" | "hnsw";
  dims: number;
  size(): number;
  upsert(id: string, vector: Float32Array): void;
  remove(id: string): void; // backend가 delete 미지원 시 tombstone
  search(query: Float32Array, k: number): Array<{ id: string; score: number }>;
  save(dir: string): void;
  load(dir: string): void;
}
```

- `bruteforce`: 현 방식 유지(embedding repository에서 vector를 가져와 cosine 계산)
- `hnsw`: `hnswlib-wasm` 사용(네이티브 빌드 없음, 오프라인 가능)

### 5.3 Vector Index 저장 레이아웃

```
.smart-context/
  vector-index/
    local/
      multilingual-e5-small/
        index.bin
        meta.json
```

`meta.json` 예시:

```json
{
  "version": 1,
  "provider": "local",
  "model": "multilingual-e5-small",
  "dims": 384,
  "count": 42150,
  "rootFingerprint": "<hash>",
  "hnsw": { "m": 16, "efConstruction": 200, "efSearch": 64 }
}
```

### 5.4 인덱스 생성/복구 플로우

1) 서버 시작 시 `VectorIndexManager`가 meta를 로드  
2) 다음 조건 중 하나면 rebuild
   - 인덱스 파일 없음
   - dims/model/provider mismatch
   - rootFingerprint 불일치
   - `SMART_CONTEXT_VECTOR_INDEX_REBUILD=on_start`
3) rebuild는 **EmbeddingRepository 전체 스캔** → index rebuild

> `auto`: 위 조건에만 rebuild(기본값, 사용자 설정 불필요).  
> `manual`: CLI로만 rebuild(대형 레포에서 startup 비용을 피하고 싶을 때).

#### 5.4.1 CLI (manual rebuild)

`manual` 모드에서는 별도 CLI로 인덱스를 생성한다.

```bash
# 기본값: SMART_CONTEXT_* 환경변수를 그대로 사용
smart-context-build-vector-index

# 예: HNSW로 강제 생성
SMART_CONTEXT_VECTOR_INDEX=hnsw \
SMART_CONTEXT_VECTOR_INDEX_REBUILD=manual \
smart-context-build-vector-index
```

CLI는 다음을 수행한다:

- `SMART_CONTEXT_ROOT` 기준으로 EmbeddingRepository 전체 스캔
- VectorIndex build + `.smart-context/vector-index/...` 저장
- 완료 시 meta.json 갱신

### 5.5 통합 지점 (코드 변경 포인트)

1) **EmbeddingRepository**
   - `listEmbeddings(provider, model)` 추가
   - index rebuild에 사용

2) **DocumentIndexer**
   - 임베딩 upsert 시 `VectorIndexManager.upsert` 호출
   - 파일 삭제 시 `VectorIndexManager.remove`

3) **DocumentSearchEngine**
   - `ensureEmbeddings` 내부에서:
     - query embedding 생성
     - ANN index에서 topK 후보 조회
     - BM25 후보와 union → RRF/MMR 결합
   - ANN 결과는 **scope/exclude** 필터를 통과한 chunk만 사용

### 5.6 Hybrid 파이프라인 (검색 흐름)

1) BM25/trigram 후보 수집  
2) ANN 후보 조회 (가능 시)  
3) 후보 집합 = `BM25 topN ∪ ANN topK`  
4) RRF로 1차 결합 → MMR로 다양성 조정  
5) 결과 출력 (stats/metrics 포함)

### 5.7 Trigram 메모리 가드레일

- `SMART_CONTEXT_TRIGRAM_MAX_DOC_FREQ`  
  - 문서 비율이 일정 비율 이상인 트라이그램은 postings에서 제거
- `SMART_CONTEXT_TRIGRAM_MAX_TERMS_PER_FILE`  
  - 파일당 저장할 trigram 개수 상한

대상 파일/확장자 필터는 기존 옵션(`SMART_CONTEXT_TRIGRAM_MAX_FILE_BYTES`, `SMART_CONTEXT_TRIGRAM_INCLUDE_EXTENSIONS`)과 병행한다.

### 5.8 메트릭/벤치 확장

필수 메트릭:

- `vector_index.build_ms`
- `vector_index.query_ms`
- `vector_index.size`
- `vector_index.backend`

Bench 추가:

- 10k/50k 샘플셋 기준 ANN vs brute-force 비교
- recall@K, p95 latency, index build time

---

## 6. 테스트/검증

1) **VectorIndex unit test**
   - add/search/remove 일관성
   - brute-force vs ANN topK overlap 확인(허용 오차 범위 내)

2) **DocumentSearchEngine integration**
   - ANN enabled/disabled 시 결과 형태/통계 검증
   - degrade path(`vector_index_unavailable`) 검증

3) **Persistence**
   - index rebuild 후 재시작 → 동일 결과 재현

---

## 7. 롤아웃 전략

1) 기본값은 `SMART_CONTEXT_VECTOR_INDEX=auto`  
   - 인덱스가 없으면 기존 brute-force 유지
2) 내부 PoC/벤치에서 `SMART_CONTEXT_VECTOR_INDEX=hnsw`로 활성화  
3) 안정성 확인 후 `auto` 기본 유지(기능이 있을 때만 활성)

---

## 8. 리스크 및 대응

| Risk | 대응 |
|---|---|
| ANN 라이브러리 호환성 | WASM 기반 선택 + fallback |
| 인덱스 rebuild 비용 | `manual` 모드 제공, 배치 빌드 CLI |
| 메모리 증가 | `max_points`, `trigram` 상한 도입 |
| 결과 품질 저하 | brute-force 대비 recall 기준선 확보 |

---

## 9. 성공 기준 (Exit Criteria)

- 10k~50k 임베딩에서 ANN 검색 p95가 brute-force 대비 개선
- hybrid 파이프라인에서 recall@K가 기준선 이상 유지
- offline 환경에서 index rebuild/로드가 재현 가능
