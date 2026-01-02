# ADR-042-003: P2 Vector Quantization + Persistence/IO Scaling (Offline-First)

**Status:** Accepted  
**Date:** 2026-01-02  
**Author:** Smart Context MCP Team  
**Related:** `docs/analysis/technical-report.md`, ADR-042-001 (P0 Offline Baseline), ADR-042-002 (P1 Hybrid ANN + Search Scaling)

---

## 1. 배경 (Context)

P0/P1을 통해 다음이 완료되었습니다.

- 오프라인/폐쇄망 실행을 전제로 한 **모델 번들 + 원격 의존 최소화**
- **네이티브 DB 제거** 및 file 기반 `IndexStore` 전환
- HNSW(WASM) 기반 ANN + hybrid search 파이프라인 연결 및 persistence
- 대형 레포에서 폭주를 막는 trigram 가드레일, 검색 품질(심볼 intent) 및 skeleton 성능 개선

하지만 P1 이후, 규모가 커질수록 병목의 중심은 다음으로 이동합니다.

1) **“어느 규모까지”를 목표로 할지(스케일 envelope) 부재** → P2 선택지가 과대/과소 설계되기 쉬움  
2) `IndexStore`의 embedding persistence가 **JSON + base64(Float32Array)** 구조라서, 임베딩 수가 커질수록
   - cold-start/restore 시간이 증가
   - 파일 크기/GC/메모리 사용량이 급증
3) ANN(HNSW) 자체는 빠르지만, 인덱스/벡터 저장이 커지면 **디스크 I/O + 메모리 상주 비용**이 지배적이 됨

따라서 P2는 (GPU/분산 제외) “오프라인에서의 최대 성능”을 위해 **스케일 기준을 고정**하고, **벡터의 저장/로드/캐시**를 중심으로 최적화합니다.

---

## 2. 범위 (Scope)

P2는 다음 3가지만 다룹니다.

1) **스케일 기준 확정 + 벤치/리그 고도화** (재현 가능한 성능/품질 기준선)
2) **벡터 압축/양자화** (저장 크기/로드 비용/메모리 상주 비용 감소)
3) **Persistence/IO 최적화** (binary pack, streaming rebuild, sharding, 캐시 정책)

명시적 제외:
- GPU 가속, 분산/클러스터, 원격 벡터 DB

---

## 3. 목표 / 비목표 (Goals / Non-Goals)

### Goals

1) **스케일 프로파일 정의 및 벤치 기준선 고정**
   - 동일 입력/시나리오에서 결과가 재현 가능해야 함
   - p50/p95/p99 latency, RSS/heap, 디스크 사용량(인덱스/임베딩) 수집

2) **Embedding persistence의 저장 포맷 개선**
   - JSON+base64 → binary pack(옵션: Q8)로 전환
   - “전체 임베딩을 한 번에 메모리에 올리지 않고” rebuild/검색 가능하도록 streaming 경로 제공

3) **Vector/Index I/O 최적화**
   - large repo에서 cold-start/restore 시간을 낮추고, 메모리 상주량을 통제
   - shard 단위 로딩/검색(merge topK)로 OOM 리스크 감소

### Non-Goals

- HNSW 엔진 자체의 구현 교체/대규모 튜닝(필요 시 P2 후반 또는 P3)
- PQ/OPQ 같은 고급 인덱스 압축(IVF-PQ) “전면 도입” (단, 실험/PoC는 가능)

---

## 4. 결정 (Decision)

P2는 아래를 채택합니다.

1) **스케일 프로파일(S/M/L) + 지표를 ADR로 고정**하고, `benchmarks/`를 그에 맞게 확장한다.
2) **Embedding persistence v1(binary pack)** 를 도입하고, 기존 JSON 포맷은 “마이그레이션 대상(legacy)”로 둔다.
3) 벡터 저장은 **float32(정확) + q8(저장/속도)** 를 선택적으로 지원한다.
   - 기본값은 안전하게 `float32` 유지(호환성)
   - 대규모 환경에서는 `q8` 또는 `both`로 전환 가능
4) VectorIndex rebuild는 **streaming iteration** 으로 변경한다(대규모에서 OOM 방지).
5) VectorIndex는 **shard**를 지원한다(한 개 거대 인덱스 대신 여러 개로 분할해 로드/검색/재빌드).

---

## 5. 상세 설계 (개발 착수 가능한 수준)

### 5.1 스케일 프로파일 및 벤치 스펙 (1)

프로젝트는 아래 3단계를 “지원 목표”로 삼는다.

| Profile | Embeddings(대략) | Repository(대략) | 목적 |
|---|---:|---:|---|
| S | ≤ 50k | ≤ 10k files | 기본 개발/로컬 |
| M | 50k–250k | 10k–50k files | 실사용(대형) |
| L | 250k–1M | 50k+ files | 폐쇄망/엔터프라이즈 |

이번 P2의 목표 스코프는 다음으로 고정한다.
- **Baseline:** Profile M
- **Stretch:** Profile L

필수 수집 지표:
- latency: `search.total_ms`(p50/p95/p99), `vector_index.query_ms`(p50/p95/p99), `vector_index.build_ms`
- memory: `process.rss`, `heapUsed`, `heapTotal`
- storage: embeddings pack bytes, vector index bytes, trigram index bytes
- quality: recall@1/recall@10(기준 쿼리셋)

벤치 실행 인터페이스(권장):
- `node --import tsx benchmarks/main.ts --scenario p2-s|p2-m|p2-l`
- 시나리오 파일: `benchmarks/scenarios/p2-*.json`
  - root/include/exclude
  - query set(+ expected top file)
  - vectorIndex backend 및 shard 설정

> 벤치가 실제 source tree에 의존하면 노이즈가 커지므로, P2에서 “고정된 query/target”과 “고정된 include/exclude”를 시나리오로 분리한다.

---

### 5.2 Embedding persistence v1: binary pack (3)

현재(file mode) 문제:
- embeddings가 `embeddings.json`에 `Float32Array`를 base64로 저장 → 대규모에서 **파일이 커지고 로드가 느림**
- `listEmbeddings()`가 내부적으로 “모든 임베딩을 메모리에 올리는” 경로로 이어지기 쉬움

#### 5.2.1 디렉토리 레이아웃

```
.smart-context/
  storage/
    # legacy(v0): files.json, chunks.json, embeddings.json, ...
    v1/
      embeddings/
        <provider>/
          <model>/
            meta.json
            embeddings.f32.bin        # optional
            embeddings.q8.bin         # optional
            embeddings.index.json     # chunkId -> offset (or binary index)
```

`meta.json` 최소 스키마:

```json
{
  "version": 1,
  "provider": "local",
  "model": "multilingual-e5-small",
  "dims": 384,
  "count": 42150,
  "format": "float32|q8|both",
  "createdAt": "2026-01-02T00:00:00.000Z"
}
```

#### 5.2.2 파일 포맷(권장)

`embeddings.f32.bin` 레코드(append-only):
- `u32 chunkIdByteLen`
- `bytes chunkId(utf-8)`
- `u16 dims`
- `f32 norm` (없으면 0)
- `f32[dims] vector` (L2 normalize 된 값 권장)

`embeddings.q8.bin` 레코드(append-only, scalar quantization):
- `u32 chunkIdByteLen`
- `bytes chunkId`
- `u16 dims`
- `f32 scale` (예: maxAbs/127)
- `i8[dims] q` (round(vector/scale), clamp [-127,127])

인덱스:
- `embeddings.index.json`: `{ "<chunkId>": { "offset": number, "format": "float32|q8" } }`
- 대형(L)에서 JSON index가 커지면 `embeddings.index.bin`로 대체(후속)

> P2의 우선 목표는 “JSON+base64 탈피 + streaming 읽기”이므로, index는 1차로 JSON 유지 가능(단 L에서 병목이면 bin으로 교체).

#### 5.2.3 API 변경(필수)

대규모에서도 OOM을 피하기 위해, 다음 중 하나를 도입한다.

**Option A (권장): streaming iterator 추가**

```ts
interface IndexStore {
  iterateEmbeddings(
    key: EmbeddingKey,
    visitor: (embedding: StoredEmbedding) => void | Promise<void>,
    options?: { limit?: number }
  ): Promise<void>;
}
```

**Option B: AsyncIterator 반환**

```ts
interface IndexStore {
  streamEmbeddings(key: EmbeddingKey, options?: { limit?: number }): AsyncIterable<StoredEmbedding>;
}
```

VectorIndex rebuild은 `listEmbeddings()`가 아니라 streaming API를 사용한다.

---

### 5.3 Q8(Scalar) 양자화 및 검색 경로 (2)

#### 5.3.1 목적

- 저장 크기 감소(대략 4B/float → 1B/q8 + scale)
- 로드/복구 속도 개선(디스크 read bytes 감소)
- brute-force / rerank 단계에서 Q8 dot/cosine로 **빠른 근사 점수** 산출 가능

#### 5.3.2 정확도/품질 정책

- `q8`는 “후보 생성/스코어링 보조”에 사용하고,
- 최종 rerank에서 필요하면 float32(정확)로 재계산할 수 있게 한다(`format=both`).

권장 기본:
- `SMART_CONTEXT_EMBEDDING_PACK_FORMAT=float32` (기본)
- 대형 레포/폐쇄망 성능 필요 시 `both` 또는 `q8`로 전환

#### 5.3.3 ENV 제안

| Variable | Default | Purpose |
|---|---:|---|
| `SMART_CONTEXT_EMBEDDING_PACK_FORMAT` | `float32` | `float32 \| q8 \| both` |
| `SMART_CONTEXT_EMBEDDING_PACK_REBUILD` | `auto` | `auto \| on_start \| manual` |
| `SMART_CONTEXT_EMBEDDING_PACK_INDEX` | `json` | `json \| bin` |
| `SMART_CONTEXT_VECTOR_INDEX_SHARDS` | `auto` | `auto \| off \| <number>` |
| `SMART_CONTEXT_VECTOR_CACHE_MB` | `128` | dequantized/float vector cache 상한 |

---

### 5.4 VectorIndex shard + IO 최적화 (3)

#### 5.4.1 shard 전략

목표: 단일 거대 인덱스 OOM/로드 지연을 줄이기 위해 “여러 인덱스로 나눠 관리”.

권장 shard key:
- **파일 경로 prefix 기반**: `src/`, `docs/`, `packages/<name>/` 등
- 또는 **chunkId hash 기반**(균등 분산)

검색 시:
- shard 별 topK를 조회한 뒤 merge하여 최종 topK를 산출(Score 기반 k-way merge)

#### 5.4.2 rebuild 정책

- shard의 `meta.json`에 `rootFingerprint` + `shardId` + `count` 기록
- 변경 파일이 shard에 영향을 주면 해당 shard만 rebuild 가능(후속 최적화)

#### 5.4.3 캐시 정책

대규모에서 “모든 벡터를 JS heap에 상주시켜” brute-force/rebuild를 하면 OOM 위험이 크다.

- float32 벡터는 필요 시 로드하고,
- Q8 벡터는 가능한 한 Q8로 점수 계산 후, 상위 후보만 float32로 재계산한다.
- `SMART_CONTEXT_VECTOR_CACHE_MB` 상한을 넘으면 LRU로 evict.

---

## 6. 마이그레이션 (Migration)

### 6.1 Legacy 포맷

기존 `IndexStore(file)`는 `embeddings.json`에 base64 vector를 저장한다.

P2에서:
- 신규 포맷 v1을 우선 사용
- `embeddings.json`이 존재하면 **자동 변환(옵션)** 또는 **manual 변환 CLI** 제공

### 6.2 CLI(제안)

- `smart-context-migrate-embeddings-pack`
  - 입력: legacy `embeddings.json`
  - 출력: v1 pack(+ index)
  - 옵션: `--format float32|q8|both`, `--index json|bin`

---

## 7. 테스트/검증 (Tests)

필수:
1) pack encode/decode roundtrip (float32/q8)
2) iterateEmbeddings(streaming)로 전체 scan 시 메모리 상주량이 선형 증가하지 않음(상한 확인)
3) legacy → pack 변환 후 결과 동일성(샘플 set에서 cosine/topK 동등 또는 허용 오차)

권장(대형 시나리오에서만):
- M/L 프로파일에서 rebuild 시간/메모리/RSS 기록(벤치 리포트로 남김)

---

## 8. 리스크 및 대응 (Risks)

| Risk | 대응 |
|---|---|
| Q8로 인한 품질 저하 | `both` 모드 + 최종 rerank float32 재계산 |
| 마이그레이션 실패/데이터 손상 | append-only + checksum(후속) + 변환 후 검증 단계 |
| index 파일(특히 JSON)이 커짐 | `embeddings.index.bin`로 단계적 전환 |
| shard 수가 많아져 쿼리 비용 증가 | shard topK 제한 + 병렬/배치 조회 + merge 최적화 |

---

## 9. 성공 기준 (Exit Criteria)

Baseline (Profile M):
- `embeddings.json`(legacy) 대비 cold-start/restore 시간이 **의미 있게 감소**(권장: 2x 이상)하고, 결과 재현성(동일 쿼리셋에서 recall@K)이 유지된다.
- 디스크 사용량(embeddings)이 `q8`에서 **대략 60~75% 절감**(float32 대비)되며, `both` 모드에서도 legacy(JSON+base64) 대비 감소한다.
- `VectorIndex rebuild`가 streaming 경로로 **OOM 없이 완료**되고, rebuild 중 peak `process.rss`/`heapUsed`가 데이터 크기에 대해 선형 폭주하지 않는다.
- 벤치 리포트에 p95/p99, RSS/heap, storage bytes, quality(recall@1/10)가 자동 기록된다.

Stretch (Profile L):
- shard 기반 로드/검색이 가능하며(`SMART_CONTEXT_VECTOR_INDEX_SHARDS=auto|N`), shard merge(topK)가 기능적으로 올바르게 동작한다.
- `embeddings.index`가 병목이 되는 경우 `bin` 인덱스 전환으로 restore 시간이 더 이상 악화되지 않는다(large index에서도 처리 가능).

---

## 10. 롤아웃 전략 (Rollout)

1) 기본값은 legacy 유지(안전) + pack 생성은 `manual`로 시작
2) 내부에서 `SMART_CONTEXT_EMBEDDING_PACK_FORMAT=both`로 검증
3) 안정성/회귀 확인 후 `auto` 전환(legacy 존재 시 migration)
