# ADR-039: Universal Document Implementation Strategy

## Status
Proposed

## Context
`smart-context-mcp`는 코드와 Markdown을 넘어 프로젝트의 전체 맥락을 파악하는 것을 목표로 합니다. 하지만 많은 비즈니스 로직, 기획 사양, 데이터 정의가 여전히 Office 문서(DOCX, XLSX) 및 PDF 형태로 존재하며, 시스템의 동작 상태를 파악하기 위한 로그(.log) 파일의 중요성도 높습니다.

단순히 텍스트를 추출하는 것을 넘어, 소프트웨어 엔지니어링 맥락에서 이 문서들을 "신뢰할 수 있는 소스(Source of Truth)" 및 "진단 증거(Diagnostic Evidence)"로 활용하기 위한 구체적인 구현 전략이 필요합니다.

## Decision
우리는 “완벽한 복원”이 아니라 **실무에 바로 도움이 되는 핵심 텍스트 + 표(테이블) 중심 추출**을 우선 목표로 하며, 각 포맷의 특성에 맞춘 **구조적 추출(Structural Extraction)** 을 채택합니다.

또한 ADR-038의 “Token-Efficient Evidence Packs & Progressive Disclosure” 원칙을 그대로 적용하여, 추출된 문서가 Six Pillars 응답에서 토큰 폭발을 일으키지 않도록 `doc_search`/`doc_section` 경로에서 preview/summary 중심으로 노출합니다.

### 1. 대상 포맷 및 우선순위
우선순위는 “구현 난이도 대비 효과” 기준으로 결정합니다.

1. **LOG (최우선 / 저난이도-고효과)**: 운영 이슈/장애 분석의 즉시 가치가 큼. 텍스트 기반이라 구현이 단순.
2. **DOCX (상 / 중난이도-고효과)**: 기획/설계 “Why/What” 문서가 많고, 헤더 구조를 살리면 검색 품질이 크게 개선됨.
3. **XLSX (중 / 중난이도-중고효과)**: 데이터 정의/에러 코드/매핑 테이블의 정확도가 높아 “정답성”에 기여.
4. **PDF (중하 / 고난이도-중효과)**: 텍스트 추출 품질 편차가 커서 “지속 튜닝 비용”이 존재. 단, 공식 스펙/외부 문서는 가치가 있음.

### 2. 기술 스택 및 파싱 전략
아래는 “구현 방향”이며, 실제 선택은 빌드/런타임 제약에 따라 조정 가능합니다.

* **DOCX**: `mammoth` 계열(HTML 변환) → HTML 기반으로 헤더 구조(H1/H2) 보존 → 텍스트화 후 기존 문서 파이프라인(Outline/Chunk/Search)에 연결
* **XLSX**: `xlsx` 계열 → 시트/테이블을 의미론적 텍스트로 변환(헤더 + row key-value) → 테이블 중심 청킹
* **PDF**: `pdfjs-dist` 계열 → 페이지 텍스트 추출 + 페이지 마커 삽입 → “텍스트 밀도 기반”으로 OCR 필요 여부를 `needs_ocr` 로만 표시(본 ADR에서는 OCR 미구현)
* **LOG**: UTF-8 텍스트 취급 + timestamp/level 정규식 전처리 → 엔트리 단위 청킹 + time-window chunking(옵션)

> OCR(이미지/스캔 PDF)은 효과가 크지만, 의존성/비용/성능/품질 편차가 커서 **본 ADR의 Non-Goal**로 제외합니다(추후 별도 ADR로 분리).

### 3. 통합 아키텍처
* `src/documents/parsers/`에 포맷별 추출기를 추가하고, **“바이너리 → 텍스트/구조”** 변환을 한 번 거친 뒤 기존 `DocumentProfiler`/`DocumentIndexer` 흐름을 최대한 재사용합니다.
* 라우팅은 `DocumentProfiler` 단이 아니라 **인덱싱 단계**에서 수행합니다(바이너리 파일은 `fileSystem.readFile(utf8)`로 읽을 수 없음).
* 추출 산출물은 “원문을 DB에 넣지 않고” **추출 텍스트/구조만** `document_chunks`에 저장합니다(바이너리 파일 자체는 저장/인덱싱하지 않음).
* 검색/응답은 ADR-038 원칙에 따라 preview/summary 중심으로 제공하고, 원문 펼치기는 `doc_section(mode=raw|maxChars)`로 제한합니다.

## Implementation Details

## Goals / Non-Goals

### Goals
- 코드/Markdown 외 포맷을 **프로젝트 문맥 검색(doc_search)** 에 포함
- 표/테이블 중심 텍스트화로 “정확한 매핑/코드/에러 코드” 근거 제공
- Token 폭발 방지(ADR-038): preview/summary 중심 + packId 기반 progressive disclosure
- 실패/저품질 케이스를 “조용히 망가뜨리지 않고” **degraded reasons로 투명하게** 노출

### Non-Goals (현실적 범위 고정)
- OCR/비전(이미지 자체 인식), 스캔 PDF 텍스트화
- PDF 레이아웃 완전 복원(컬럼/각주/표 경계 완벽 추정)
- Office 스타일/서식의 완전 복원

## Work Breakdown & Prioritization (난이도/효과 기반)

아래 작업들은 “효과가 큰데 난이도가 낮은 것”부터 진행합니다. 각 작업은 독립적으로 merge 가능하도록 설계합니다.

### P0 — LOG 지원 (최우선)
- **효과**: 장애/운영 분석에서 즉시 가치, 파일 수 대비 인덱싱 비용도 통제 가능
- **난이도**: 낮음(텍스트 파이프라인 재사용)
- **핵심 구현 포인트**
  - 확장자 `.log`를 인덱싱 대상에 포함(기본 kind=`text` 또는 신규 kind=`log`)
  - 정규식 기반 log 엔트리 분할 + (옵션) time-window 묶음
  - degrade reasons 예: `log_parse_fallback`, `log_truncated_by_budget`

### P1 — DOCX 지원 (고효과 / 중난이도)
- **효과**: 기획/설계 문서의 “Why/What” 근거를 코드와 함께 검색 가능
- **난이도**: 중간(외부 라이브러리 + 구조 보존/노이즈 필터)
- **핵심 구현 포인트**
  - DOCX → HTML(헤더 유지) → 텍스트 변환(헤더 경계 유지)
  - “이미지”는 OCR 없이 placeholder만 남김(alt/caption이 있으면 텍스트로 포함)
  - degrade reasons 예: `docx_parse_failed`, `docx_missing_text`, `docx_embedded_images_ignored`

### P2 — XLSX 지원 (테이블 중심 / 중난이도-중고효과)
- **효과**: 데이터 정의/매핑 테이블 기반 “정답성” 향상
- **난이도**: 중간(시트/셀/헤더 처리, 노이즈 컷 룰 필요)
- **핵심 구현 포인트**
  - 테이블을 텍스트로 변환할 때 “행 맥락”을 유지(헤더 반복/키-값 형태)
  - 빈 셀/서식 노이즈 제거, 큰 시트는 샘플링/row cap
  - degrade reasons 예: `xlsx_too_large_sampled`, `xlsx_parse_failed`, `xlsx_empty_sheet_skipped`

### P3 — PDF 지원 (중효과 / 고난이도)
- **효과**: 공식 스펙/외부 문서 검색 가능
- **난이도**: 높음(텍스트 추출 품질 편차 + 유지보수 부담)
- **핵심 구현 포인트**
  - 페이지 단위 텍스트 추출 + 페이지 마커(예: `[[page: 3]]`)
  - 텍스트 밀도가 낮으면 `needs_ocr`로 degrade만 표시(추출 텍스트가 없으면 “메타만” 남김)
  - degrade reasons 예: `pdf_needs_ocr`, `pdf_parse_failed`, `pdf_low_text_density`

## Data Model / Contracts (개발 가능한 수준의 인터페이스)

### Extractor output (바이너리/로그 포함 공통)

추출기는 파일을 읽고(바이너리 포함), 아래 형태로 “인덱싱 가능한 텍스트/구조”를 반환합니다.

```ts
export type UniversalDocFormat = "log" | "docx" | "xlsx" | "pdf";

export type UniversalDocDegradeReason =
  | "parse_failed"
  | "needs_ocr"
  | "too_large_sampled"
  | "empty"
  | "unsupported_encryption"
  | "timeout";

export type UniversalDocBlockKind = "heading" | "paragraph" | "table" | "image" | "log_entry" | "unknown";

export interface UniversalDocBlock {
  kind: UniversalDocBlockKind;
  path?: string[];          // ex) ["Install", "Troubleshooting"] or ["Sheet: Errors"]
  rangeHint?: { startLine?: number; endLine?: number; page?: number };
  text: string;             // already textified (no binary)
  meta?: Record<string, unknown>;
}

export interface UniversalExtractedDocument {
  format: UniversalDocFormat;
  filePath: string;
  title?: string;
  blocks: UniversalDocBlock[];
  degraded: boolean;
  reasons?: UniversalDocDegradeReason[];
  stats?: {
    inputBytes?: number;
    outputChars: number;
    extractedPages?: number;
    extractedTables?: number;
    samplingApplied?: boolean;
    durationMs?: number;
  };
}
```

### Chunking strategy (구조적 청킹)
블록/테이블/로그 엔트리를 “문서 outline/sectionPath”로 매핑하여 기존 `document_chunks` 스키마에 맞게 저장합니다.

#### LOG
- 기본: 엔트리 단위(`timestamp + level + message`) 블록
- 옵션: time-window(예: 5분) 묶음 chunk

#### DOCX
- HTML 헤더 기반(제목/헤더 path) → paragraph/table을 해당 path에 귀속

#### XLSX
- `["Sheet: <name>", "Table: <range or header signature>"]` 형태의 path 생성
- row는 `key=value` 또는 `Header: v1 | v2 | ...` 형태

#### PDF
- 페이지 마커 기반 path(`["Page: 3"]`) + 문단 단위 분할(가능하면)

### Structural Chunking (구조적 청킹)
단순 길이 기반 청킹이 아닌 문서의 논리적 단위를 인식합니다.
- **DOCX**: 섹션(Section) 단위 청킹
- **XLSX**: 테이블/시트 단위 청킹 (헤더 행 반복 포함)
- **PDF**: 문단(Paragraph) 단위 청킹
- **LOG**: 로그 엔트리 또는 시간 블록 단위 청킹

### Noise Reduction
- 문서 내 불필요한 스타일 정보, 메타데이터 필드, 빈 셀 등은 필터링하여 인덱스 크기를 최적화합니다.
- 바이너리 파일 자체는 인덱싱하지 않으며, 추출된 텍스트와 메타데이터만 `IndexDatabase`에 저장합니다.

## Operational Controls (성능/보안/예산)

### 기본 방어 정책(권장)
- **파일 크기 제한/샘플링**: 대형 PDF/XLSX는 전부 읽지 않고 sampling 또는 row/page cap
- **타임박스**: 파일당 파싱 시간 제한(초 단위) 후 degrade 처리
- **민감정보 리스크**: 기본은 “그대로” 인덱싱하되, 추후 정책이 필요하면 별도 ADR에서 redaction/allowlist를 정의

### Degraded Contract(투명성)
파싱 실패/저품질은 “빈 결과”가 아니라 다음을 포함해야 합니다.
- `degraded: true`
- `reasons: [...]` (예: `needs_ocr`, `parse_failed`, `too_large_sampled`)
- 가능한 경우: “어디까지 됐는지” stats 제공(추출 페이지 수/샘플링 여부)

## Implementation Plan (현실적 작업 순서)

각 단계는 “인덱싱→검색→doc_section”까지 end-to-end로 최소 동작하게 만든 뒤 다음 단계로 진행합니다.

### Phase 0 — LOG + TXT (.log/.txt) first
- 인덱싱 대상에 `.log`/`.txt` 포함(텍스트 파이프라인 재사용)
- log entry chunking + preview 요약(ADR-038) 경로 연결
- 테스트: log 샘플로 `doc_search`가 의미 있는 결과를 반환

### Phase 1 — DOCX (text + headings + tables)
- DOCX 파서 추가(HTML 변환 기반)
- 헤더 path/테이블 텍스트화
- 이미지/도표는 OCR 없이 placeholder + 캡션/alt 텍스트만(가능한 범위)
- 파서 미설치/실패 시 `docx_parser_missing` / `docx_parse_failed` degrade 이유 노출
- 테스트: DOCX 샘플에서 헤더 기반 outline/섹션 검색이 동작

### Phase 2 — XLSX (table-first)
- XLSX 파서 추가(시트/테이블 텍스트화)
- row cap / sampling 정책 적용
- 테스트: 에러코드 테이블 형태 샘플에서 `doc_search` precision 확인

### Phase 3 — PDF (best-effort text)
- PDF 텍스트 추출 + 페이지 마커 + `needs_ocr` degrade
- 테스트: 텍스트 PDF는 검색 가능, 스캔형(텍스트 밀도 낮음)은 degrade reason 노출

## Consequences

### Positive
- **지식 영토 확장**: 코드에 설명되지 않은 "비즈니스 결정 이유(Why)"를 에러 추론 및 기능 구현에 활용할 수 있습니다.
- **진단 능력 강화**: 로그 파일(.log)을 맥락에 포함함으로써 실행 시점의 문제와 코드를 직접 연결하여 분석할 수 있습니다.
- **정확도 향상**: 데이터 매핑 테이블(XLSX)을 기반으로 한 정확한 상수 및 에러 코드 추천이 가능해집니다.

### Negative / Risks
- **의존성 증가**: 라이브러리 추가로 인한 패키지 크기 증가.
- **성능 부하**: 바이너리 파싱은 일반 텍스트보다 CPU 집약적이므로 `IncrementalIndexer`를 통한 철저한 캐싱이 필수적입니다.
- **보안**: 문서 및 로그 내에 포함된 민감 정보(개인정보, API 키 등)가 인덱싱될 수 있으므로 주의가 필요합니다.

## Success Metrics (측정 가능한 기준)
- 포맷별 최소 1개 샘플에서 `doc_search(output=compact)`가 **유의미한 섹션 preview**를 반환
- 스캔 PDF/암호화 문서 등 실패 케이스에서 `degraded/reasons`가 항상 설정됨(침묵 실패 금지)
- 대형 XLSX/PDF에서 sampling/timeout이 동작하고, 시스템이 멈추지 않음
- Six Pillars 응답 크기가 ADR-038의 목적(토큰 효율)을 훼손하지 않음(원문 자동 첨부 금지 유지)
