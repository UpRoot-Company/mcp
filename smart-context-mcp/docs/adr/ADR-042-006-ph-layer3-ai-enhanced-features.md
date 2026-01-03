# ADR-042-006: PH Layer 3 AI-Enhanced Features (Smart Fuzzy Match, AST Impact, Code Generation)

**Status:** ✅ **Implemented** (2026-01-03)  
**Date:** 2026-01-03  
**Author:** Smart Context MCP Team  
**Related:** ADR-042-005 (Layer 2 완결), ADR-016 (Impact Flow Analysis), ADR-018 (Clustered Search), ADR-033 (Six Pillars)

---

## Implementation Status

✅ **All phases successfully implemented:**

**Phase 0: Infrastructure** ✅
- SymbolVectorRepository (200+ lines, integrated with VectorIndexManager)

**Phase 1: Smart Fuzzy Match** ✅
- SymbolEmbeddingIndex (209 lines, 16 tests passing)
- IntentToSymbolMapper (298 lines, 26 tests passing)
- EditResolver integration with smartMatch option

**Phase 2: AST Impact** ✅
- AstDiffEngine (226 lines, 24 tests passing)
- SymbolImpactAnalyzer (335 lines, 7 tests passing)
- AutoRepairSuggester (318 lines, 2 tests passing)

**Phase 2.5: Quick Code Generation** ✅
- StyleInference (456 lines, 16 tests passing)
- SimpleTemplateGenerator (315 lines, 28 tests passing)
- WritePillar quickGenerate integration

**Phase 3: Full Code Generation** ✅
- PatternExtractor (651 lines, 28 tests passing)
- TemplateGenerator (361 lines, 22 tests passing)
- WritePillar smartWrite integration with VectorSearch → PatternExtractor → TemplateGenerator pipeline

**Test Status:** 648/648 tests passing (117 suites)  
**ENV Gates:** All 6 Layer 3 settings implemented in ConfigurationManager

---

## 1. 배경 (Context)

ADR-042-005를 통해 **Layer 2 (안정적 편집 인프라)**가 완성되었다:
- ✅ EditResolver: 결정적 resolve (NO_MATCH/AMBIGUOUS_MATCH 명확)
- ✅ EditCoordinator: indexRange 기반 O(1) apply + atomic batch + rollback
- ✅ 비용 상한: timeout 제거, 빠른 실패 + guidance
- ✅ change/write 일관된 트랜잭션 모델

이제 이 **견고한 토대 위에** AI 역량을 얹어 Agent의 편집 정확도/효율성을 극대화할 수 있다.

### 1.1 현재 Agent의 한계

Layer 2만으로는 다음 상황에서 여전히 Agent가 어려움을 겪는다:

1. **모호한 의도 표현** ("add 함수를 찾아서 고쳐줘")
   - Agent는 정확한 targetString을 모름 → 여러 turn 소요
   - String matching은 오타/변형에 취약

2. **연쇄 수정의 누락** ("함수 시그니처 변경 시 호출부 미수정")
   - 현재 ImpactAnalyzer는 file-level만 보고 → symbol-level 영향 파악 안 됨
   - Agent가 수동으로 관련 파일 찾아야 함

3. **프로젝트 스타일 불일치** ("새 파일 생성 시 import 스타일이 다름")
   - Agent는 프로젝트 convention을 학습 못함
   - 생성된 코드가 linter/formatter를 통과 못할 수 있음

### 1.2 Layer 3의 역할

Layer 3는 **Layer 2를 대체하지 않고 강화**한다:

```
Agent: "add 함수를 고쳐줘"
  ↓
Layer 3: Embedding Search → "Calculator.add (line 45)" (confidence: 0.95)
  ↓
Layer 2: EditResolver → indexRange { start: 1234, end: 1250 }
  ↓
Layer 2: EditCoordinator → Apply (빠르고 안전하게)
```

**핵심 원칙**: Layer 3가 실패해도 Layer 2로 graceful degradation.

---

## 2. 목표 (Goals)

다음 3가지 AI 기능을 도입하여 Agent의 turn count를 획기적으로 줄인다:

1. **Smart Fuzzy Match (Embedding-based Symbol Search)**
   - 자연어 의도 → 정확한 코드 위치 (symbol-level)
   - 목표: "add 함수" → 90%+ 정확도로 indexRange 반환

2. **Real-time AST Impact Analysis (Symbol-level)**
   - 함수 시그니처 변경 시 → 영향받는 caller/callee 자동 탐지
   - 목표: Breaking change 80%+ 정확도로 예측 + batch edit 제안

3. **Context-Aware Code Generation (Style Learning)**
   - 기존 프로젝트 코드 패턴 학습 → 일관된 스타일로 코드 생성
   - 목표: 생성 코드 80%+ 컴파일 성공 (타입 에러 없음)

### 2.1 성공 지표

- **Agent turn count**: 현재 ~6 turns/task → 목표 **< 2 turns** (평균)
- **Smart Match 정확도**: Top-3 candidates 중 **> 90%** 정답 포함
- **Impact 정밀도**: False positive **< 10%** (불필요한 파일 제안 최소화)
- **Code Quality**: 생성 코드 **> 80%** 즉시 사용 가능 (lint 통과)

---

## 3. 비목표 (Non-Goals)

- **실시간 파일 감시**: File watcher 기반 incremental parsing은 추후 최적화 (첫 버전은 on-demand)
- **크로스 언어 지원**: TypeScript/JavaScript에 집중 (Python, Rust 등은 별도 ADR)
- **AI Model Fine-tuning**: 기존 multilingual-e5-small 모델 사용 (커스텀 학습 제외)
- **IDE 통합**: VS Code extension은 별도 트랙

---

## 4. 현 상태 분석 (As-Is)

### 4.1 기존 인프라 (재사용 가능)

| 컴포넌트 | 위치 | 현재 기능 | Layer 3 활용 |
|---------|------|----------|-------------|
| **TransformersEmbeddingProvider** | `src/embeddings/` | Local embedding (multilingual-e5-small) | Intent & Symbol embedding |
| **VectorIndexManager** | `src/vector/` | HNSW index, shard partitioning | Symbol similarity search |
| **CallGraphBuilder** | `src/ast/CallGraphBuilder.ts` | Symbol-level call graph (upstream/downstream) | AST Impact의 기반 |
| **SymbolIndex** | `src/ast/SymbolIndex.ts` | Class, function, method 추출 | Symbol 후보 제공 |
| **ImpactAnalyzer** | `src/engine/ImpactAnalyzer.ts` | File-level risk scoring | Symbol-level 확장 필요 |
| **SkeletonGenerator** | `src/ast/SkeletonGenerator.ts` | AST-based code structure | 패턴 추출용 |
| **SearchEngine** | `src/engine/SearchEngine.ts` | Hybrid BM25 + Trigram | File discovery |

**강점**:
- Embedding pipeline 이미 production-ready (DocumentSearchEngine에서 검증)
- CallGraphBuilder 이미 multi-file traversal 지원
- AST parsing (tree-sitter) 안정적

**제약**:
- VectorIndexManager는 현재 doc chunks만 index (code symbols 미지원)
- ImpactAnalyzer는 file-level만 분석 (symbol-level 없음)
- DataFlowTracer는 single-file에 국한 (cross-file 추적 불가)

### 4.2 Layer 2 의존성 (필수 전제조건)

ADR-042-005 완료 필수:
- `EditResolver.resolveAll()` - 안정적 resolve
- `EditCoordinator.applyResolvedEdits()` - atomic apply
- `ResolvedEdit` / `ResolveError` 타입 정의

**Integration Point**:
```typescript
// Layer 3가 Layer 2를 호출하는 방식
const matches = await smartFuzzyMatch(intent);  // Layer 3
const resolved = await editResolver.resolveAll(  // Layer 2 검증
  filePath, 
  [{ indexRange: matches[0].range, ... }]
);
```

---

## 5. 결정 (Decision)

다음을 채택한다:

### 5.1 Feature 1: Smart Fuzzy Match (우선순위 1)

**핵심 설계**:
1. **SymbolEmbeddingIndex** (신규)
   - 모든 symbol (class, function, method)을 embedding으로 변환 & index
   - Metadata: name, type, signature, file, lineRange
   - Incremental update: 파일 변경 시 해당 symbol만 re-embed

2. **IntentToSymbolMapper** (신규)
   - Agent intent → embedding → Top-K symbol retrieval
   - Score normalization: embedding similarity * confidence weights
   - Return: `{ symbolId, filePath, indexRange, confidence }`

3. **EditResolver Fallback Extension**
   - Resolve 우선순위에 "embedding-based match" 추가:
     1. indexRange (기존)
     2. lineRange + exact match (기존)
     3. **Embedding match (신규)** ← Layer 3
     4. Fuzzy/Levenshtein (기존)
   - AMBIGUOUS_MATCH 시 embedding으로 candidate 재정렬

**계약**:
```typescript
interface SmartMatchRequest {
  intent: string;  // "find the add function"
  fileScope?: string[];  // Optional: narrow to specific files
  topK?: number;  // Default: 3
}

interface SmartMatchResult {
  matches: Array<{
    symbolId: string;
    symbolName: string;
    filePath: string;
    indexRange: { start: number; end: number };
    confidence: number;  // 0.0-1.0
    context: string;  // Preview snippet
  }>;
  resolvedEdit?: ResolvedEdit;  // If confidence > threshold, auto-resolve
  degraded?: boolean;  // True if embedding failed → fallback to string match
}
```

### 5.2 Feature 2: Real-time AST Impact (우선순위 2)

**핵심 설계**:
1. **SymbolImpactAnalyzer** (ImpactAnalyzer 확장)
   - Current: File-level blast radius
   - **New**: Symbol-level affected callers/callees via CallGraphBuilder
   - Breaking change detection: AST diff (not heuristic)

2. **AstDiffEngine** (신규)
   - Compare AST before/after edit
   - Detect:
     - Signature changes (param count, types, return type)
     - Symbol rename/move
     - Visibility changes (public → private)
   - Use tree-sitter queries

3. **AutoRepairSuggester** (신규)
   - Given affected call sites → suggest batch edits
   - Example: `foo(a, b)` → `foo(a, b, defaultValue)` if param added
   - Return as batch edit proposal (preview mode)

**계약**:
```typescript
interface SymbolImpactRequest {
  filePath: string;
  symbolName: string;
  proposedChange: Edit;
}

interface SymbolImpactResult {
  affectedSymbols: Array<{
    symbolId: string;
    filePath: string;
    lineNumber: number;
    impactType: "caller" | "callee" | "type_dependency";
    breakingChange: boolean;
  }>;
  suggestedEdits?: Array<{
    filePath: string;
    edits: Edit[];
    rationale: string;
  }>;
  riskLevel: "low" | "medium" | "high";
}
```

### 5.3 Feature 3: Context-Aware Code Generation (우선순위 3)

**핵심 설계**:
1. **PatternExtractor** (신규)
   - Given similar files (via embedding search) → extract:
     - Import patterns (ESM vs CommonJS, relative vs absolute)
     - Naming conventions (camelCase, PascalCase)
     - Code structure (JSDoc, export style, error handling)
   - Use AST queries + regex

2. **TemplateGenerator** (신규)
   - Template engine for code generation
   - Variables: `{functionName}`, `{params}`, `{returnType}`
   - Apply extracted patterns from PatternExtractor

3. **StyleInference** (신규)
   - Detect:
     - Indent style (tabs vs spaces, size)
     - Quote style (single vs double)
     - Semicolons (yes/no)
   - EditorConfig fallback → infer from majority files

**계약**:
```typescript
interface SmartWriteRequest {
  intent: string;  // "create a utility function for date formatting"
  targetPath?: string;  // Optional: target file
  similar?: string[];  // Optional: reference files
}

interface SmartWriteResult {
  generatedCode: string;
  appliedPatterns: {
    importStyle: string;
    namingConvention: string;
    indentStyle: string;
  };
  confidence: number;
  edit?: ResolvedEdit;  // Ready to apply via EditCoordinator
}
```

---

## 6. 설계 상세 (To-Be)

### 6.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Agent Layer (MCP Tools)                                │
│  - smartChange({ intent })                              │
│  - smartWrite({ intent })                               │
└───────────────────┬─────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 3: AI Enhancement (NEW)                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Feature 1: IntentToSymbolMapper                 │    │
│  │   → SymbolEmbeddingIndex                        │    │
│  ├─────────────────────────────────────────────────┤    │
│  │ Feature 2: SymbolImpactAnalyzer                 │    │
│  │   → AstDiffEngine → AutoRepairSuggester         │    │
│  ├─────────────────────────────────────────────────┤    │
│  │ Feature 3: PatternExtractor → TemplateGen       │    │
│  │   → StyleInference                              │    │
│  └─────────────────────────────────────────────────┘    │
└───────────────────┬─────────────────────────────────────┘
                    ↓ (delegates to)
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Stable Edit Infrastructure (ADR-042-005)      │
│  - EditResolver.resolveAll()                            │
│  - EditCoordinator.applyResolvedEdits()                 │
│  → indexRange 기반, atomic, rollback                    │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Data Flow: Smart Fuzzy Match

```
1. Agent: "change the add function"
   ↓
2. IntentToSymbolMapper:
   - Embed "add function" → [0.12, 0.43, ...]
   - VectorIndexManager.search() → Top-3 symbols
   - Rank by: (embedding_sim * 0.7) + (name_match * 0.3)
   ↓
3. Result:
   [
     { symbolId: "Calculator.add", confidence: 0.95, indexRange: {...} },
     { symbolId: "MathHelper.add", confidence: 0.78, indexRange: {...} },
     { symbolId: "StringUtils.add", confidence: 0.45, indexRange: {...} }
   ]
   ↓
4. If confidence > 0.85:
   → Auto-resolve to ResolvedEdit
   Else:
   → Return candidates to Agent (user picks)
   ↓
5. EditResolver.resolveAll(indexRange) → validate & apply
```

### 6.3 Data Flow: AST Impact

```
1. Agent: "change function signature: add(a, b) → add(a, b, c)"
   ↓
2. AstDiffEngine:
   - Parse before/after AST
   - Detect: param count changed (2 → 3)
   ↓
3. SymbolImpactAnalyzer:
   - CallGraphBuilder.getCallers("add") → [app.ts:15, calc.ts:42]
   - Mark as breaking change
   ↓
4. AutoRepairSuggester:
   - Generate batch edits:
     app.ts:15: "add(x, y)" → "add(x, y, defaultValue)"
     calc.ts:42: "add(1, 2)" → "add(1, 2, 0)"
   ↓
5. Return preview to Agent → Agent approves → EditCoordinator.applyBatchEdits()
```

### 6.4 Data Flow: Code Generation

```
1. Agent: "create a utility function for date formatting"
   ↓
2. VectorIndexManager.search("date formatting") → Similar files: [utils/date.ts, helpers/time.ts]
   ↓
3. PatternExtractor:
   - Analyze utils/date.ts:
     - Import: "import { format } from 'date-fns'"
     - Naming: camelCase
     - Export: "export const formatDate = (...) => {...}"
   ↓
4. TemplateGenerator:
   - Apply patterns:
     ```typescript
     import { format } from 'date-fns';
     
     export const formatCustomDate = (date: Date, pattern: string): string => {
       return format(date, pattern);
     };
     ```
   ↓
5. StyleInference: indent=2 spaces, quotes=single, semicolons=yes
   ↓
6. EditCoordinator.applyResolvedEdits() with safeWrite → rollback 가능
```

---

## 7. 구현 계획 (Phased Rollout)

### Phase 0: Infrastructure Prerequisites (1주) ⚠️ **CRITICAL**

**목표**: VectorIndexManager를 code symbols 지원하도록 확장 (현재는 doc chunks만 지원)

**작업 단위**:
1. **VectorIndexManager 확장** (3일)
   - **파일**: `src/vector/VectorIndexManager.ts`
   - **수정 범위**:
     - `indexDocumentChunk()` → `indexItem(item: VectorItem)` 일반화
     - `VectorItem = DocumentChunk | CodeSymbol` 타입 추가
     - Metadata schema 확장: `{ type: 'doc' | 'symbol', filePath, lineRange?, symbolType? }`
   - **기존 코드 영향**: DocumentSearchEngine 호출부 수정 없음 (backward compatible)

2. **SymbolVectorRepository 추가** (2일)
   - **파일**: `src/indexing/SymbolVectorRepository.ts` (신규)
   - **역할**: SymbolIndex → VectorIndexManager 브리지
   - **인터페이스**:
     ```typescript
     interface CodeSymbol {
       symbolId: string;
       name: string;
       type: 'class' | 'function' | 'method';
       filePath: string;
       lineRange: { start: number; end: number };
       signature?: string;
     }
     
     class SymbolVectorRepository {
       async indexSymbol(symbol: CodeSymbol): Promise<void>;
       async searchSymbols(query: string, topK: number): Promise<CodeSymbol[]>;
       async updateSymbol(symbolId: string, symbol: CodeSymbol): Promise<void>;
     }
     ```

3. **Incremental Update 전략** (2일)
   - **파일**: `src/indexing/IncrementalIndexer.ts` (수정)
   - **추가 로직**:
     - 파일 변경 감지 → 해당 파일의 symbols만 re-index
     - Symbol fingerprint (name + signature hash) 기반 변경 감지
     - Batch re-indexing: 변경된 symbols 10개씩 묶어서 처리

**Acceptance Criteria**:
- [ ] VectorIndexManager에 1000+ symbols indexing < 5s
- [ ] Symbol search latency < 50ms (P95)
- [ ] 기존 DocumentSearchEngine 테스트 전부 통과 (regression 없음)

**리스크**:
- VectorIndexManager API 변경 시 DocumentSearchEngine 영향 → backward compatibility 필수
- Embedding batch size 조정 필요 (symbols는 doc chunks보다 짧음)

---

### Phase 1: Smart Fuzzy Match (2주)

**목표**: Embedding-based symbol search 동작

**Dependencies**: ⚠️ Phase 0 완료 필수

**작업 단위**:
1. **SymbolEmbeddingIndex 구현** (3일)
   - `src/embeddings/SymbolEmbeddingIndex.ts` 신규
   - SymbolIndex + TransformersEmbeddingProvider 통합
   - Batch embedding (10 symbols/batch) + caching
   - Shard by file for incremental update

2. **IntentToSymbolMapper 구현** (2일)
   - `src/engine/IntentToSymbolMapper.ts` 신규
   - VectorIndexManager integration
   - Score normalization: embedding * 0.7 + name_match * 0.3

3. **EditResolver Fallback Chain** (2일)
   - **파일**: `src/engine/EditResolver.ts` (수정)
   - **수정 범위**:
     ```typescript
     // 기존:
     private async resolveOne(edit: Edit): Promise<ResolvedEdit | ResolveError> {
       // 1. indexRange 우선
       // 2. lineRange + exact match
       // 3. fuzzy/levenshtein
     }
     
     // 추가:
     private async resolveOne(edit: Edit, options?: { smartMatch?: boolean }): Promise<ResolvedEdit | ResolveError> {
       // 1. indexRange 우선 (변경 없음)
       // 2. lineRange + exact match (변경 없음)
       // 2.5. **NEW: Embedding-based match** (smartMatch=true일 때만)
       if (options?.smartMatch && edit.intent) {
         const embeddingMatch = await this.tryEmbeddingMatch(edit.intent, edit.filePath);
         if (embeddingMatch && embeddingMatch.confidence > THRESHOLD) {
           return embeddingMatch;
         }
       }
       // 3. fuzzy/levenshtein (fallback)
     }
     
     private async tryEmbeddingMatch(intent: string, filePath: string): Promise<ResolvedEdit | null> {
       try {
         const mapper = this.intentToSymbolMapper;  // Injected dependency
         const result = await mapper.mapIntent(intent, { fileScope: [filePath], topK: 1 });
         return result.resolvedEdit || null;
       } catch (error) {
         // Degradation: return null → fall through to fuzzy
         return null;
       }
     }
     ```
   - **기존 코드 영향**:
     - `EditCoordinator.applyEdits()` 호출부: `options` 파라미터 전달 추가
     - `ResolveError` 타입: `EMBEDDING_FAILED` 에러 코드 추가
   - **Backward Compatibility**: `smartMatch` 옵션 없으면 기존 동작 유지

4. **Tool Exposure** (1일)
   - `src/orchestration/pillars/ChangePillar.ts` 확장
   - Add `smartMatch` option (default: false)
   - ENV gate: `SMART_CONTEXT_LAYER3_SMART_MATCH=true`

5. **테스트** (2일)
   - `src/tests/embeddings/SymbolEmbeddingIndex.test.ts`
   - Intent → Symbol accuracy: 100 test cases
   - Latency: < 200ms (P95)

**Acceptance Criteria**:
- [ ] SymbolEmbeddingIndex builds for 1000+ symbols in < 5s
- [ ] Top-3 accuracy > 85% (manual eval on 50 queries)
- [ ] Graceful degradation when embedding fails

### Phase 2: AST Impact (3주)

**목표**: Symbol-level breaking change detection + batch edit suggestion

**작업 단위**:
1. **AstDiffEngine 구현** (1주)
   - `src/ast/AstDiffEngine.ts` 신규
   - Tree-sitter incremental parsing
   - Detect signature/visibility changes

2. **SymbolImpactAnalyzer** (1주)
   - `src/engine/SymbolImpactAnalyzer.ts` 신규
   - CallGraphBuilder integration
   - Risk scoring: breaking vs non-breaking

3. **AutoRepairSuggester** (3일)
   - `src/engine/AutoRepairSuggester.ts` 신규
   - Template-based edit generation
   - Heuristic: add default values for new params

4. **Orchestration** (2일)
   - ChangePillar: `includeSymbolImpact` option
   - Return `suggestedEdits` in preview mode

5. **테스트** (2일)
   - 50 breaking change scenarios
   - False positive rate < 10%

**Acceptance Criteria**:
- [ ] AST diff < 50ms per file
- [ ] CallGraph traversal (depth 3) < 100ms
- [ ] Suggested edits compile (80%+)

### Phase 2.5: Quick Win - Basic Code Generation (1주) 🚀 **PRIORITIZED**

**목표**: Agent 경험 향상을 위해 기본적인 code generation 먼저 구현 (full feature는 Phase 3)

**Rationale**: 
- Feature 2 (AST Impact)는 정확도가 중요 → 3주 필요
- 하지만 Agent는 단순 boilerplate 생성에 즉시 도움이 필요
- StyleInference만 먼저 구현해도 70% 효과 달성 가능

**작업 단위**:
1. **StyleInference 구현** (3일)
   - **파일**: `src/generation/StyleInference.ts` (신규)
   - **범위**: EditorConfig parsing + majority voting
   - **출력**: `{ indent, quotes, semicolons, lineEndings }`

2. **SimpleTemplateGenerator** (2일)
   - **파일**: `src/generation/SimpleTemplateGenerator.ts` (신규)
   - **템플릿**: function, class, interface 3가지만
   - **Variable substitution**: `{name}`, `{params}`, `{returnType}`

3. **WritePillar 통합** (2일)
   - **파일**: `src/orchestration/pillars/WritePillar.ts` (수정)
   - **옵션**: `quickGenerate=true` 추가
   - **로직**: StyleInference → SimpleTemplateGenerator → safeWrite

**Acceptance Criteria**:
- [ ] 생성 코드 linter 통과 > 70%
- [ ] Latency < 200ms
- [ ] Agent가 "create a function" 요청 시 즉시 코드 생성 가능

---

### Phase 3: Full Code Generation (2.5주)

**목표**: 프로젝트 스타일 학습 + 고급 패턴 생성

**Dependencies**: Phase 2.5 완료

**작업 단위** (Phase 2.5에서 구현 안 된 부분):

**작업 단위**:
1. **PatternExtractor** (1.5주)
   - `src/generation/PatternExtractor.ts` 신규
   - AST queries for import/export patterns
   - Naming convention detection (regex + AST)

2. **TemplateGenerator** (1주)
   - `src/generation/TemplateGenerator.ts` 신규
   - Mustache-like template engine
   - Variable substitution

3. **StyleInference** (3일)
   - `src/generation/StyleInference.ts` 신규
   - EditorConfig parser
   - Majority voting for indent/quotes

4. **WritePillar Integration** (1주)
   - `smartWrite` tool exposure
   - VectorSearch → PatternExtractor → TemplateGenerator → apply

5. **테스트** (3일)
   - 30 generation tasks (utils, components, types)
   - Lint pass rate > 80%

**Acceptance Criteria**:
- [ ] Generated code matches project style (manual review)
- [ ] Compile success > 80%
- [ ] Latency < 500ms (including search)

---

## 8. 환경 변수 및 설정

### 8.1 ENV Gates (단계별 활성화)

```bash
# Feature 1
SMART_CONTEXT_LAYER3_SMART_MATCH=true|false  # default: false
SMART_CONTEXT_LAYER3_SMART_MATCH_THRESHOLD=0.85  # auto-resolve threshold

# Feature 2
SMART_CONTEXT_LAYER3_SYMBOL_IMPACT=true|false  # default: false
SMART_CONTEXT_LAYER3_IMPACT_MAX_DEPTH=3  # CallGraph depth

# Feature 3
SMART_CONTEXT_LAYER3_CODE_GEN=true|false  # default: false
SMART_CONTEXT_LAYER3_GEN_SIMILAR_COUNT=5  # files to analyze
```

### 8.2 Tool Options

```typescript
// change tool
interface ChangeOptions {
  smartMatch?: boolean;  // Use Layer 3 Smart Fuzzy Match
  includeSymbolImpact?: boolean;  // Use Layer 3 AST Impact
  // ... existing options
}

// write tool (new)
interface WriteOptions {
  smartGenerate?: boolean;  // Use Layer 3 Code Generation
  styleReference?: string[];  // Explicit reference files
  // ... existing options
}
```

---

## 9. 성능 예산 및 품질 기준

### 9.1 성능 제약

| Operation | P50 | P95 | P99 |
|-----------|-----|-----|-----|
| Symbol Embedding (batch 10) | 30ms | 50ms | 100ms |
| Vector Search (10K symbols) | 50ms | 100ms | 200ms |
| AST Diff (1 file) | 20ms | 50ms | 100ms |
| CallGraph Traversal (depth 3) | 50ms | 100ms | 200ms |
| Pattern Extraction (5 files) | 30ms | 50ms | 80ms |
| **Total Layer 3 Overhead** | **< 200ms** | **< 500ms** | **< 1s** |

**Fallback 보장**:
- 모든 Layer 3 operation은 timeout 내 완료 못하면 Layer 2로 자동 degradation
- Embedding 실패 시 string matching 사용
- AST parsing 실패 시 file-level impact로 회귀

### 9.2 품질 목표

| Metric | Target | Measurement |
|--------|--------|-------------|
| Smart Match Top-3 Accuracy | > 90% | Manual eval (100 queries) |
| Impact False Positive Rate | < 10% | Breaking change detection |
| Generated Code Compilability | > 80% | TypeScript compiler |
| Agent Turn Count Reduction | < 2 turns/task | End-to-end task scenarios (현재 ~6 turns) |

---

## 10. 테스트 전략

### 10.1 Unit Tests

- **SymbolEmbeddingIndex**: 1000 symbols indexing, incremental update
- **IntentToSymbolMapper**: 50 intent queries, ranking correctness
- **AstDiffEngine**: 30 signature change scenarios
- **PatternExtractor**: 20 project styles (imports, naming, formatting)

### 10.2 Integration Tests

- **Smart Match + EditResolver**: Intent → indexRange → apply (end-to-end)
- **AST Impact + Batch Edit**: Breaking change → suggested edits → rollback
- **Code Generation + safeWrite**: Intent → generated code → write → undo

### 10.3 Performance Regression

- CI에서 각 operation latency budget 검증
- P95 초과 시 build fail

### 10.4 Accuracy Benchmark

```bash
# benchmarks/scenarios/layer3-accuracy.json
{
  "smart_match": [
    { "intent": "find add function", "expected": "Calculator.add", "confidence_min": 0.85 },
    { "intent": "date formatting utility", "expected": "utils/date.ts", "confidence_min": 0.8 }
  ],
  "ast_impact": [
    { "change": "add(a,b) → add(a,b,c)", "expected_affected": ["app.ts:15", "calc.ts:42"] }
  ],
  "code_gen": [
    { "intent": "create logger", "expected_pattern": "ESM import", "lint_pass": true }
  ]
}
```

실행:
```bash
npm run benchmark:layer3
```

---

## 11. 롤아웃 전략

### Stage 0: Infrastructure (1주)

- [ ] SymbolEmbeddingIndex 구현
- [ ] ENV gates 추가
- [ ] Metrics 정의

**검증**:
- Embedding pipeline 동작 확인
- Latency < 100ms (batch 10)

### Stage 1: Smart Match (Alpha, 2주)

- [ ] `SMART_CONTEXT_LAYER3_SMART_MATCH=true`
- [ ] Internal testing only
- [ ] 100 query manual evaluation

**검증**:
- Top-3 accuracy > 85%
- No regressions in Layer 2

### Stage 2: AST Impact (Beta, 3주)

- [ ] `SMART_CONTEXT_LAYER3_SYMBOL_IMPACT=true`
- [ ] Limited rollout (opt-in)

**검증**:
- False positive < 10%
- Suggested edits compile

### Stage 3: Code Generation (Gamma, 4주)

- [ ] `SMART_CONTEXT_LAYER3_CODE_GEN=true`
- [ ] Controlled rollout

**검증**:
- Lint pass > 80%
- Style consistency (manual review)

### Stage 4: GA (General Availability)

- [ ] All features default ON
- [ ] 1 month monitoring
- [ ] Agent turn count < 2 confirmed

---

## 12. 성공 기준 (Exit Criteria)

다음을 만족하면 ADR-042-006 완료:

1. **기능 완성도**:
   - [ ] Smart Match top-3 accuracy > 90% (100 queries)
   - [ ] AST Impact false positive < 10% (50 scenarios)
   - [ ] Code Generation lint pass > 80% (30 tasks)

2. **성능**:
   - [ ] Layer 3 overhead P95 < 500ms
   - [ ] No Layer 2 regression (resolve/apply latency 유지)

3. **Agent 효율**:
   - [ ] Turn count < 2 (평균, 10 representative tasks)
   - [ ] Task success rate > 95% (현재 ~85%)

4. **운영 안정성**:
   - [ ] Degradation 동작 확인 (embedding 실패 시)
   - [ ] Rollback to Layer 2 < 1s
   - [ ] 1 month production: zero critical incidents

---

## 13. 리스크 및 완화

| 리스크 | 영향 | 완화 전략 |
|-------|------|----------|
| **Embedding Latency** | User-facing delay | Batch processing, caching, async indexing |
| **False Positives (Impact)** | Unnecessary edits | Conservative threshold (confidence > 0.8) |
| **Generated Code Errors** | Broken builds | safeWrite (rollback), dry-run preview |
| **Memory Overhead** | OOM on large repos | Shard embeddings, lazy loading |
| **Model Dependency** | Offline usage breaks | Bundled model, graceful degradation |

---

## 14. 의존성 및 전제조건

### 14.1 필수 전제조건 (Blockers)

**개발 착수 전 반드시 확인**:

1. **✅ ADR-042-005 완료** (Layer 2 안정화)
   - Verification: `npm test -- EditResolver.test.ts && npm test -- EditCoordinator.test.ts`
   - Expected: All tests pass, `LEVENSHTEIN_BLOCKED` 에러 코드 존재

2. **✅ VectorIndexManager 동작** (DocumentSearchEngine 검증 완료)
   - Verification: `npm test -- DocumentSearchEngine.test.ts`
   - Expected: Embedding pipeline < 100ms (batch 10)

3. **✅ CallGraphBuilder 성능** (< 100ms for typical files)
   - Verification: `npm run benchmark -- --filter=callgraph`
   - Expected: P95 < 100ms

4. **🔴 TransformersEmbeddingProvider 모델 번들링**
   - **Critical**: `multilingual-e5-small` 모델이 로컬에 존재해야 함
   - Path: `models/multilingual-e5-small/` (already exists)
   - Verification:
     ```bash
     ls -lh models/multilingual-e5-small/
     # Expected: onnx 파일 + tokenizer.json 존재
     ```

5. **🔴 tree-sitter 바인딩 빌드**
   - **Critical**: AST parsing을 위한 native binding 필요
   - Verification:
     ```bash
     npm ls tree-sitter
     node -e "require('tree-sitter')"
     # Expected: No errors
     ```

### 14.2 개발 환경 설정

**Phase 0 착수 전 환경 준비**:

```bash
# 1. Dependencies 설치
npm install --save-dev @types/tree-sitter

# 2. Embedding model 다운로드 (이미 존재하면 skip)
ls models/multilingual-e5-small/ || npm run download:models

# 3. ENV 설정
cat > .env.layer3 <<EOF
SMART_CONTEXT_LAYER3_SMART_MATCH=false  # Phase 1에서 활성화
SMART_CONTEXT_LAYER3_SYMBOL_IMPACT=false  # Phase 2에서 활성화
SMART_CONTEXT_LAYER3_CODE_GEN=false  # Phase 2.5에서 활성화
SMART_CONTEXT_EMBEDDING_BATCH_SIZE=10
SMART_CONTEXT_VECTOR_INDEX_SHARD_SIZE=1000
EOF

# 4. Phase 0 작업 브랜치 생성
git checkout -b feature/layer3-phase0-infrastructure

# 5. Baseline 성능 측정
npm run benchmark:baseline
# → Phase 1 이후 regression 비교용
```

### 14.2 권장 전제조건 (Nice-to-have)

- EditorConfig support (for StyleInference)
- Project-level .tsconfig.json (for type inference hints)

---

## 15. 향후 확장 (Post ADR-042-006)

### 15.1 언어 확장

- Python AST analysis (via tree-sitter-python)
- Rust pattern extraction
- Multi-language embedding model (e.g., CodeBERT)

### 15.2 Real-time 최적화

- File watcher → incremental AST parsing
- Streaming results (progressive symbol search)

### 15.3 고급 AI

- Fine-tuned embedding model (domain-specific)
- LLM-based code repair (GPT-4 integration)

---

## 16. 결론

ADR-042-006은 **Layer 2의 견고한 토대 위에** AI 역량을 얹어 Agent의 편집 능력을 극대화한다.

**핵심 원칙**:
- Layer 3는 enhancement, not replacement
- 실패 시 graceful degradation to Layer 2
- 성능/품질 trade-off 명확히 설정

**예상 효과**:
- Agent turn count: 6 turns → **2 turns** (3배 향상)
- Task success rate: 85% → **95%** (10%p 증가)
- User satisfaction: "정확하고 빠른" AI 코딩 어시스턴트

**Timeline**: 총 8.5주 (Phase 0: 1주, Phase 1: 2주, Phase 2: 3주, Phase 2.5: 1주, Phase 3: 2.5주)

### Day-level Breakdown (Phase 0 예시)

**Week 1: Phase 0 Infrastructure**
- Day 1-2: VectorIndexManager API 일반화 (`indexItem()` 구현, 타입 확장)
- Day 3: SymbolVectorRepository 뼈대 구현 (interface + mock)
- Day 4: IncrementalIndexer symbol re-indexing 로직
- Day 5: Integration testing + regression check (DocumentSearchEngine)

**Week 2-3: Phase 1 Smart Match**
- Day 1-3: SymbolEmbeddingIndex (embedding batch, caching)
- Day 4-5: IntentToSymbolMapper (scoring, ranking)
- Day 6-7: EditResolver fallback chain 구현
- Day 8: ChangePillar integration
- Day 9-10: Unit + Integration tests

**Week 4-6: Phase 2 AST Impact**
- Week 4: AstDiffEngine (tree-sitter incremental parsing)
- Week 5: SymbolImpactAnalyzer + CallGraphBuilder integration
- Week 6: AutoRepairSuggester + testing

**Week 7: Phase 2.5 Quick Win**
- Day 1-3: StyleInference (EditorConfig + majority voting)
- Day 4-5: SimpleTemplateGenerator
- Day 6-7: WritePillar integration + testing

**Week 8-9: Phase 3 Full Code Gen** (if needed)
- Week 8: PatternExtractor (AST-based)
- Week 9: TemplateGenerator + advanced features

---

## Appendix A: 파일 구조 및 수정 체크리스트

### A.1 신규 파일 (NEW)

```
src/
├── embeddings/
│   └── SymbolEmbeddingIndex.ts       # Phase 1, Feature 1
├── indexing/
│   └── SymbolVectorRepository.ts     # Phase 0 (Infrastructure)
├── engine/
│   ├── IntentToSymbolMapper.ts       # Phase 1, Feature 1
│   ├── SymbolImpactAnalyzer.ts       # Phase 2, Feature 2
│   └── AutoRepairSuggester.ts        # Phase 2, Feature 2
├── ast/
│   └── AstDiffEngine.ts              # Phase 2, Feature 2
└── generation/
    ├── StyleInference.ts             # Phase 2.5 (Quick Win)
    ├── SimpleTemplateGenerator.ts    # Phase 2.5 (Quick Win)
    ├── PatternExtractor.ts           # Phase 3, Feature 3
    └── TemplateGenerator.ts          # Phase 3, Feature 3
```

### A.2 수정 파일 (MODIFIED) - 구체적 변경 범위

| 파일 | Phase | 변경 내용 | 영향 범위 | Backward Compatible? |
|------|-------|----------|----------|---------------------|
| **src/vector/VectorIndexManager.ts** | 0 | `indexDocumentChunk()` → `indexItem()` 일반화 | DocumentSearchEngine 호출부 | ✅ Yes (optional param) |
| **src/indexing/IncrementalIndexer.ts** | 0 | Symbol re-indexing 로직 추가 | SymbolIndex 통합 | ✅ Yes (기존 로직 유지) |
| **src/engine/EditResolver.ts** | 1 | `tryEmbeddingMatch()` 메서드 추가, fallback chain 확장 | EditCoordinator | ✅ Yes (`smartMatch` 옵션) |
| **src/orchestration/pillars/ChangePillar.ts** | 1 | `smartMatch` 옵션 추가, IntentToSymbolMapper 호출 | change tool schema | ✅ Yes (default: false) |
| **src/orchestration/pillars/ChangePillar.ts** | 2 | `includeSymbolImpact` 옵션 추가 | change tool schema | ✅ Yes (default: false) |
| **src/orchestration/pillars/WritePillar.ts** | 2.5 | `quickGenerate` 옵션, StyleInference 통합 | write tool schema | ✅ Yes (default: false) |
| **src/types.ts** | 1 | `ResolveError` 타입에 `EMBEDDING_FAILED` 추가 | EditResolver error handling | ⚠️ Breaking (but enum extension) |

### A.3 테스트 파일 (TEST)

```
src/tests/
├── vector/
│   └── VectorIndexManager.symbols.test.ts        # Phase 0
├── embeddings/
│   └── SymbolEmbeddingIndex.test.ts              # Phase 1
├── engine/
│   ├── IntentToSymbolMapper.test.ts              # Phase 1
│   ├── EditResolver.smartMatch.test.ts           # Phase 1
│   ├── SymbolImpactAnalyzer.test.ts              # Phase 2
│   └── AutoRepairSuggester.test.ts               # Phase 2
├── ast/
│   └── AstDiffEngine.test.ts                     # Phase 2
└── generation/
    ├── StyleInference.test.ts                    # Phase 2.5
    └── PatternExtractor.test.ts                  # Phase 3
```

### A.4 Integration Test Scenarios

```typescript
// src/tests/integration/layer3.integration.test.ts

describe('Layer 3 Integration', () => {
  describe('Phase 1: Smart Fuzzy Match', () => {
    it('should resolve intent to indexRange', async () => {
      const result = await change({
        intent: 'find add function',
        smartMatch: true
      });
      expect(result.resolvedEdit.indexRange).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0.85);
    });
    
    it('should fallback to fuzzy if embedding fails', async () => {
      // Mock TransformersEmbeddingProvider to throw
      const result = await change({ intent: 'add', smartMatch: true });
      expect(result.degraded).toBe(true);
      expect(result.resolveMethod).toBe('fuzzy');  // Layer 2 fallback
    });
  });
  
  describe('Phase 2: AST Impact', () => {
    it('should detect breaking changes', async () => {
      const result = await change({
        filePath: 'calc.ts',
        edits: [{ /* change add(a,b) → add(a,b,c) */ }],
        includeSymbolImpact: true
      });
      expect(result.affectedSymbols).toHaveLength(2);  // app.ts, calc.ts
      expect(result.suggestedEdits).toBeDefined();
    });
  });
  
  describe('Phase 2.5: Quick Code Gen', () => {
    it('should generate code with project style', async () => {
      const result = await write({
        intent: 'create a logger function',
        quickGenerate: true
      });
      expect(result.generatedCode).toContain('export const');  // ESM style
      expect(result.appliedPatterns.indent).toBe(2);  // spaces
    });
  });
});
```

---

## Appendix B: 참고 구현 (Pseudo-code)

### B.1 Smart Fuzzy Match

```typescript
// src/engine/IntentToSymbolMapper.ts
export class IntentToSymbolMapper {
  async mapIntent(intent: string, options?: { fileScope?: string[]; topK?: number }): Promise<SmartMatchResult> {
    // 1. Embed intent
    const intentEmbedding = await this.embeddingProvider.embed(intent);
    
    // 2. Search symbols
    const candidates = await this.symbolIndex.search(intentEmbedding, {
      topK: options?.topK || 3,
      filter: options?.fileScope
    });
    
    // 3. Rank & score
    const ranked = candidates.map(c => ({
      ...c,
      confidence: this.computeConfidence(c, intent)
    })).sort((a, b) => b.confidence - a.confidence);
    
    // 4. Auto-resolve if high confidence
    if (ranked[0].confidence > THRESHOLD) {
      return {
        matches: ranked,
        resolvedEdit: this.toResolvedEdit(ranked[0])
      };
    }
    
    return { matches: ranked };
  }
  
  private computeConfidence(candidate: any, intent: string): number {
    const embeddingSim = candidate.similarity;
    const nameMatch = this.fuzzyMatch(candidate.name, intent);
    return embeddingSim * 0.7 + nameMatch * 0.3;
  }
}
```

### B.2 AST Impact

```typescript
// src/engine/SymbolImpactAnalyzer.ts
export class SymbolImpactAnalyzer {
  async analyzeImpact(request: SymbolImpactRequest): Promise<SymbolImpactResult> {
    // 1. Detect change type
    const diff = await this.astDiff.compare(
      request.filePath,
      request.proposedChange
    );
    
    if (!diff.isBreaking) {
      return { affectedSymbols: [], riskLevel: "low" };
    }
    
    // 2. Find affected symbols
    const callers = await this.callGraph.getCallers(request.symbolName);
    const callees = await this.callGraph.getCallees(request.symbolName);
    
    // 3. Generate repair suggestions
    const suggestions = await this.repairSuggester.suggest(diff, callers);
    
    return {
      affectedSymbols: [...callers, ...callees],
      suggestedEdits: suggestions,
      riskLevel: this.assessRisk(callers.length)
    };
  }
}
```

### B.3 Code Generation

```typescript
// src/generation/TemplateGenerator.ts
export class TemplateGenerator {
  async generate(request: SmartWriteRequest): Promise<SmartWriteResult> {
    // 1. Find similar files
    const similar = await this.vectorSearch.search(request.intent, { topK: 5 });
    
    // 2. Extract patterns
    const patterns = await this.patternExtractor.extract(similar.map(s => s.filePath));
    
    // 3. Infer style
    const style = await this.styleInference.infer(patterns);
    
    // 4. Generate code
    const template = this.selectTemplate(request.intent);
    const code = template.render({
      ...this.parseIntent(request.intent),
      patterns,
      style
    });
    
    return {
      generatedCode: code,
      appliedPatterns: patterns,
      confidence: this.assessQuality(code)
    };
  }
}
```

---

**End of ADR-042-006**
