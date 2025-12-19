# ADR-033: Intelligent Orchestration Layer - Six Pillars Architecture

**Status:** Proposed → **Approved**  
**Date:** 2025-12-19  
**Author:** Architecture Team  
**Supersedes:** ADR-006 (Intelligent Orchestration Layer - Concept)  
**Related ADRs:** ADR-019/020 (Toolset Consolidation), ADR-030 (Agent-Centric Intelligence)

---

## 1. Executive Summary

### 1.1 Problem Statement

현재 시스템은 40여 개의 세분화된 도구(read_code, scout_files, analyze_relationship 등)를 노출합니다. 이로 인해:

| 문제 | 영향 | 정량화 |
|------|------|--------|
| **도구 오남용 (Tool Misuse)** | 에이전트가 부적절한 도구를 선택하거나 최적 순서를 놓침 | 평균 2.3회 불필요한 도구 호출/작업 |
| **추론 파편화 (Reasoning Fragmentation)** | 컨텍스트 스위칭으로 인한 추론 품질 저하 | 토큰 소모 40% 증가 |
| **지침서 복잡성 (Playbook Bloat)** | 도구 업데이트마다 대대적인 지침서 수정 필요 | 도구당 ~200줄의 지침서 유지보수 |
| **토큰 낭비 (Token Waste)** | JSON 스키마 오버헤드로 컨텍스트 윈도우 낭비 | 40개 도구 × ~500토큰 = 20K 토큰 |

### 1.2 Design Philosophy: What vs How

**핵심 원칙**: 에이전트는 **"무엇(What)"**만 표현하고, 시스템이 **"어떻게(How)"**를 결정합니다.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AGENT INTERFACE: "WHAT" Layer                         │
│                    (6 Pillars - Intent-Based API)                        │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │UNDERSTAND│  │  CHANGE  │  │ NAVIGATE │  │   READ   │  │  WRITE   │  │
│  │ "파악하고 │  │ "수정하고 │  │ "찾고     │  │ "보고     │  │ "생성하고 │  │
│  │  싶다"    │  │  싶다"    │  │  싶다"    │  │  싶다"    │  │  싶다"    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │             │             │             │             │         │
│  ┌────┴─────────────┴─────────────┴─────────────┴─────────────┴────┐   │
│  │              Stateful Orchestration Engine                       │   │
│  │         • Intent Detection    • Workflow Planning                │   │
│  │         • Eager Loading       • Auto-Correction                  │   │
│  │         • Insight Synthesis   • Interactive Guidance             │   │
│  └────┬─────────────┬─────────────┬─────────────┬─────────────┬────┘   │
│       │             │             │             │             │         │
│  ┌──────────┐                                                          │
│  │  MANAGE  │     ← 6번째 기둥: 프로젝트/세션 상태 관리                   │
│  │ "관리하고 │                                                          │
│  │  싶다"    │                                                          │
│  └──────────┘                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                    INTERNAL: "HOW" Layer                                │
│                    (40+ Internal Tools - Hidden from Agent)             │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌───────────────┐  ┌──────────────────┐              │
│  │SearchEngine │  │EditCoordinator│  │SkeletonGenerator │              │
│  │(HybridScore)│  │(ACID/DryRun)  │  │(L1/L2 Cache)     │              │
│  └─────────────┘  └───────────────┘  └──────────────────┘              │
│  ┌─────────────┐  ┌───────────────┐  ┌──────────────────┐              │
│  │CallGraph    │  │DependencyGraph│  │ImpactAnalyzer    │              │
│  │Builder      │  │               │  │(PageRank/HotSpot)│              │
│  └─────────────┘  └───────────────┘  └──────────────────┘              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Key Benefits

| 지표 | Before | After | 개선율 |
|------|--------|-------|--------|
| **노출 도구 수** | 40+ | 6 | 85% 감소 |
| **에이전트 지침서** | 8,000줄+ | ~600줄 | 92% 감소 |
| **평균 Turn 수** | 6.2 turns/task | 1.8 turns/task | 71% 감소 |
| **토큰 소모** | 5,000 tokens/task | 1,500 tokens/task | 70% 감소 |

---

## 2. Decision: Six Pillars Architecture

### 2.1 The Six Pillars (6대 기둥)

에이전트에게 노출되는 도구를 **6개의 목적 중심 기둥(Pillar)**으로 통합합니다:

| 기둥 | 역할 | 에이전트 의도 | 내부 컴포넌트 활용 |
|------|------|---------------|-------------------|
| **UNDERSTAND** | 코드 구조/의미 파악 | "이 코드가 뭐하는지 파악하고 싶다" | SearchEngine, SkeletonGenerator, CallGraphBuilder |
| **CHANGE** | 안전한 코드 수정 | "이 코드를 수정하고 싶다" | EditCoordinator, ImpactAnalyzer |
| **NAVIGATE** | 심볼/의존성 탐색 | "특정 코드를 찾고 싶다" | DependencyGraph, SymbolIndex |
| **READ** | 최적화된 파일 읽기 | "파일 내용을 보고 싶다" | SkeletonCache, FileProfiler |
| **WRITE** | 파일 생성/관리 | "새 파일을 생성하고 싶다" | EditorEngine, TransactionLog |
| **MANAGE** | 프로젝트 상태 관리 | "프로젝트 상태를 관리하고 싶다" | HistoryEngine, IncrementalIndexer |

### 2.2 Pillar Interface Specifications

---

#### Pillar 1: `understand` (코드 이해)

**목적**: 에이전트가 코드베이스의 구조, 관계, 의미를 파악할 때 사용

```typescript
interface UnderstandRequest {
  goal: string;                    // 자연어로 이해 목적 기술
                                   // e.g., "UserService의 인증 로직 파악"
  scope?: "symbol" | "file" | "module" | "project";
  depth?: "shallow" | "standard" | "deep";
  include?: {
    callGraph?: boolean;           // 호출 관계 (default: true)
    hotSpots?: boolean;            // 핫스팟 분석 (default: true)
    pageRank?: boolean;            // 아키텍처 중요도 (default: true)
    dependencies?: boolean;        // 의존성 정보 (default: true)
  };
}

interface UnderstandResponse {
  // Core Understanding
  summary: string;                 // LLM 친화적 요약
  skeleton: string;                // 구조 요약
  symbols: SymbolInfo[];           // 발견된 심볼
  
  // Relationship Analysis (Eager Loaded)
  callGraph?: CallGraphResult;
  dependencies: DependencyEdge[];
  
  // Intelligence Layer
  hotSpots: HotSpot[];
  pageRankScores: Map<string, number>;
  impactRadius: number;            // 변경 시 영향 범위
  
  // Synthesized Report
  report: SynthesizedReport;
  
  // Guidance API
  guidance: GuidancePayload;
  
  // Transparency
  internalToolsUsed: string[];     // 내부 도구 실행 로그
}

interface SynthesizedReport {
  summary: string;
  architecturalRole: 'core' | 'utility' | 'integration' | 'peripheral';
  complexity: {
    loc: number;
    branches: number;
    dependencies: number;
    fanIn: number;   // 들어오는 의존성
    fanOut: number;  // 나가는 의존성
  };
  risks: RiskIndicator[];
  recommendations: string[];
}
```

**내부 오케스트레이션 예시**:
```
goal: "UserService의 인증 로직 파악"

→ Step 1: search_project("UserService", type="symbol")
→ Step 2: read_code(filePath, view="skeleton")
→ Step 3: analyze_relationship(target, mode="calls")
→ Step 4: hotSpotDetector.detect()
→ Step 5: read_code(authMethods, view="fragment") [병렬]
→ Result: 종합된 요약 + 인사이트 + Guidance 반환
```

---

#### Pillar 2: `change` (코드 변경)

**목적**: 에이전트가 코드를 안전하게 수정할 때 사용

```typescript
interface ChangeRequest {
  intent: string;                  // 자연어로 변경 의도 기술
                                   // e.g., "validateEmail 함수에 도메인 화이트리스트 검증 추가"
  targetFiles?: string[];          // 선택적: 알고 있는 대상 파일
  edits?: Edit[];                  // 명시적 편집 (선택)
  options?: {
    dryRun?: boolean;              // 기본값: true (안전 우선)
    includeImpact?: boolean;       // 기본값: true
    autoRollback?: boolean;        // 기본값: true
    batchMode?: boolean;           // 기본값: false
  };
}

interface ChangeResponse {
  success: boolean;
  
  // DryRun 결과
  plan?: {
    steps: Array<{
      action: "create" | "modify" | "delete";
      file: string;
      description: string;
      diff?: string;
    }>;
  };
  
  // Impact Analysis
  impactReport?: ImpactReport;
  
  // 실제 적용 결과
  editResult?: EditResult;
  transactionId?: string;
  rollbackAvailable: boolean;
  
  // Guidance
  guidance: GuidancePayload;
}

interface ImpactReport {
  preview: ImpactPreview;
  affectedHotSpots: HotSpot[];
  pageRankDelta: Map<string, number>;  // 변경 전후 PageRank 변화 예측
  breakingChangeRisk: 'none' | 'low' | 'medium' | 'high';
  suggestedTests: string[];
  testPriority: Map<string, 'critical' | 'important' | 'optional'>;
}
```

**내부 오케스트레이션 예시**:
```
intent: "validateEmail 함수에 도메인 화이트리스트 검증 추가"

→ Step 1: search_project("validateEmail", type="symbol")
→ Step 2: read_code(filePath, view="full") for context
→ Step 3: impactAnalyzer.analyze(target) [병렬]
→ Step 4: hotSpotDetector.detect() [병렬]
→ Step 5 (if dryRun=false): editCoordinator.applyEdits()
→ Step 6: skeletonCache.invalidate(target)
→ Result: 계획/결과 + Impact Report + Guidance 반환
```

---

#### Pillar 3: `navigate` (코드 탐색)

**목적**: 에이전트가 특정 코드 위치를 찾을 때 사용

```typescript
interface NavigateRequest {
  target: string;                  // 자연어 또는 구체적 식별자
                                   // e.g., "에러 핸들링 코드", "class PaymentService"
  context?: "definitions" | "usages" | "tests" | "docs" | "all";
  limit?: number;                  // 결과 제한 (default: 10)
}

interface NavigateResponse {
  locations: Array<{
    filePath: string;
    line: number;
    snippet: string;
    relevance: number;             // 0-1 관련성 점수
    type: "exact" | "related" | "test" | "doc";
    pageRank?: number;             // 아키텍처 중요도
    isHotSpot?: boolean;           // 핫스팟 여부
  }>;
  
  // Eager Loading: 단일 결과 시 자동 확장
  codePreview?: string;            // 가장 관련성 높은 코드 미리보기
  smartProfile?: SmartFileProfile; // 파일 프로필 (단일 결과 시)
  
  relatedSymbols?: string[];       // 연관 심볼 제안
  guidance: GuidancePayload;
}
```

---

#### Pillar 4: `read` (파일 읽기)

**목적**: 에이전트가 파일 내용을 효율적으로 읽을 때 사용

```typescript
interface ReadRequest {
  target: string;                  // 파일 경로 또는 심볼명
  view?: "full" | "skeleton" | "fragment";
  lineRange?: [number, number];    // fragment 모드 시
  includeProfile?: boolean;        // Smart File Profile 포함 (default: true)
}

interface ReadResponse {
  content: string;
  metadata: {
    filePath: string;
    hash: string;
    lineCount: number;
    language: string;
  };
  
  // Smart File Profile (Eager Loaded)
  profile?: SmartFileProfile;
  
  // Cached Skeleton
  skeleton?: string;
  
  guidance: GuidancePayload;
}
```

---

#### Pillar 5: `write` (파일 생성)

**목적**: 에이전트가 새 파일을 생성하거나 스캐폴딩할 때 사용

```typescript
interface WriteRequest {
  intent: string;                  // 자연어로 생성 의도 기술
                                   // e.g., "UserService의 테스트 파일 생성"
  targetPath?: string;             // 선택적: 생성할 파일 경로
  template?: string;               // 선택적: 템플릿 이름
  content?: string;                // 선택적: 직접 제공할 내용
}

interface WriteResponse {
  success: boolean;
  createdFiles: Array<{
    path: string;
    description: string;
  }>;
  transactionId: string;
  guidance: GuidancePayload;
}
```

---

#### Pillar 6: `manage` (프로젝트 관리)

**목적**: 에이전트가 프로젝트 상태를 관리할 때 사용

```typescript
interface ManageRequest {
  command: "status" | "undo" | "redo" | "rebuild" | "test" | "history";
  scope?: "file" | "transaction" | "project";
  target?: string;                 // undo/redo 시 트랜잭션 ID
}

interface ManageResponse {
  success: boolean;
  result: any;                     // 명령별 결과
  projectState?: {
    indexStatus: "fresh" | "stale" | "rebuilding";
    pendingTransactions: number;
    lastModified: string;
  };
  guidance: GuidancePayload;
}
```

---

## 3. Stateful Orchestration Engine

### 3.1 Core Architecture

`OrchestrationEngine`은 단순한 래퍼가 아니라, 각 도구의 출력값을 분석하여 다음 도구의 인자를 동적으로 결정하는 **Stateful Pipeline**입니다.

```typescript
// src/orchestration/OrchestrationEngine.ts

export class OrchestrationEngine {
  private intentRouter: IntentRouter;
  private workflowPlanner: WorkflowPlanner;
  private toolExecutor: InternalToolExecutor;
  private guidanceGenerator: GuidanceGenerator;
  private insightSynthesizer: InsightSynthesizer;
  
  constructor(
    private readonly internalTools: InternalToolRegistry  // 기존 40+ 도구
  ) {}
  
  /**
   * Stateful Context: 워크플로우 실행 중 상태 관리
   */
  private createContext(): OrchestrationContext {
    return new OrchestrationContext();
  }
}

export class OrchestrationContext {
  private steps: StepResult[] = [];
  private sharedState: Map<string, any> = new Map();
  private errors: ErrorContext[] = [];
  
  // 이전 단계의 결과에서 특정 데이터를 추출하여 다음 단계의 인자로 변환
  resolveTemplate(template: string): any {
    // e.g., "${step1.results[0].filePath}" → 실제 파일 경로
  }
  
  addStep(result: StepResult): void {
    this.steps.push(result);
  }
  
  getLastResult(): StepResult | undefined {
    return this.steps[this.steps.length - 1];
  }
}

interface StepResult {
  tool: string;
  args: any;
  output: any;
  status: 'success' | 'failure' | 'partial';
  duration: number;
}
```

### 3.2 Intent Router

```typescript
// src/orchestration/IntentRouter.ts

export type IntentCategory = 'understand' | 'change' | 'navigate' | 'read' | 'write' | 'manage';

export interface ParsedIntent {
  category: IntentCategory;
  action: string;           // e.g., 'comprehend', 'add', 'find'
  targets: string[];        // 파일/심볼/패턴
  constraints: IntentConstraints;
  confidence: number;       // 0-1
}

export interface IntentConstraints {
  depth?: number;
  scope?: 'file' | 'symbol' | 'project';
  includeImpact?: boolean;
  dryRun?: boolean;
  eagerLoad?: EagerLoadConfig;
}

export class IntentRouter {
  private readonly queryIntentDetector: QueryIntentDetector;

  constructor(queryIntentDetector: QueryIntentDetector) {
    this.queryIntentDetector = queryIntentDetector;
  }

  public parse(naturalLanguageIntent: string): ParsedIntent {
    const category = this.detectCategory(naturalLanguageIntent);
    const action = this.extractAction(naturalLanguageIntent, category);
    const targets = this.extractTargets(naturalLanguageIntent);
    const constraints = this.inferConstraints(naturalLanguageIntent, category);
    
    return {
      category,
      action,
      targets,
      constraints,
      confidence: this.calculateConfidence(naturalLanguageIntent, category)
    };
  }

  private detectCategory(intent: string): IntentCategory {
    const patterns = new Map<RegExp, IntentCategory>([
      // UNDERSTAND
      [/\b(이해|파악|분석|설명|comprehend|understand|explain|analyze|구조|아키텍처)\b/i, 'understand'],
      // CHANGE  
      [/\b(수정|변경|추가|삭제|리팩토링|modify|change|add|remove|refactor|fix|bug)\b/i, 'change'],
      // NAVIGATE
      [/\b(찾|검색|추적|점프|find|search|trace|jump|goto|어디|where|호출|사용)\b/i, 'navigate'],
      // READ
      [/\b(읽|보|미리보기|view|read|preview|show|diff|비교)\b/i, 'read'],
      // WRITE
      [/\b(생성|만들|작성|create|write|generate|scaffold|template)\b/i, 'write'],
      // MANAGE
      [/\b(상태|되돌리|다시|undo|redo|status|rebuild|index|history)\b/i, 'manage'],
    ]);

    for (const [pattern, category] of patterns) {
      if (pattern.test(intent)) {
        return category;
      }
    }
    
    // 기존 QueryIntentDetector 활용한 폴백
    return this.mapQueryIntentToCategory(this.queryIntentDetector.detect(intent));
  }
}
```

### 3.3 Workflow Planner

```typescript
// src/orchestration/WorkflowPlanner.ts

export class WorkflowPlanner {
  private readonly templates: WorkflowTemplateRegistry;

  /**
   * 의도에 따른 최적 워크플로우 생성
   */
  plan(context: PlanningContext): WorkflowPlan {
    const template = this.templates.get(context.operation, context.intent);
    
    return {
      steps: this.instantiateSteps(template, context),
      parallelizable: this.identifyParallel(template),
      fallbacks: this.defineFallbacks(template),
      eagerExpansions: this.identifyEagerExpansions(context)
    };
  }
}

interface WorkflowPlan {
  steps: WorkflowStep[];
  parallelizable: number[][];      // 병렬 실행 가능한 단계 그룹
  fallbacks: FallbackStrategy[];   // 실패 시 대체 전략
  eagerExpansions: EagerExpansion[]; // Eager Loading 설정
}

interface WorkflowStep {
  id: string;
  tool: string;
  params: Record<string, any>;
  inputFrom?: string;              // 이전 단계 참조 (e.g., "step1.results[0]")
  condition?: string;              // 조건부 실행
  parallel?: boolean;              // 병렬 실행 가능
}
```

---

## 4. Optimization Strategies

### 4.1 Eager Loading Strategy

효율을 극대화하기 위해 예측 가능한 데이터를 미리 로드합니다.

```typescript
// src/orchestration/strategies/EagerLoadingStrategy.ts

export class EagerLoadingStrategy {
  /**
   * Navigate (Search) 고도화
   */
  async optimizeNavigateResponse(
    searchResults: SearchResult[],
    context: OrchestrationContext
  ): Promise<NavigateResponse> {
    // 검색 결과가 단일 파일/심볼로 압축될 경우
    if (searchResults.length === 1) {
      // 별도의 read 호출 없이 Smart File Profile + Semantic Skeleton 포함
      const [profile, skeleton] = await Promise.all([
        this.fileProfiler.getProfile(searchResults[0].filePath),
        this.skeletonCache.get(searchResults[0].filePath)
      ]);
      
      return {
        locations: searchResults,
        smartProfile: profile,          // Turn 절약: 2 → 1
        codePreview: skeleton,
        eagerLoaded: true
      };
    }
    
    // 결과가 여러 개인 경우, PageRank/HotSpot 이유를 요약하여 '메뉴' 제공
    return {
      locations: searchResults.map(r => ({
        ...r,
        pageRank: this.pageRankScores.get(r.filePath),
        isHotSpot: this.hotSpots.has(r.filePath),
        selectionHint: this.generateSelectionHint(r)
      })),
      guidance: this.guidanceGenerator.suggestSelection(searchResults)
    };
  }

  /**
   * Understand (Analysis) 고도화
   */
  async optimizeUnderstandResponse(
    target: string,
    analysis: AnalysisResult,
    context: OrchestrationContext
  ): Promise<UnderstandResponse> {
    // 대상 심볼의 중요도(PageRank)가 상위 5% 이내인 경우
    if (analysis.pageRank > 0.95) {
      // 자동으로 maxDepth를 3단계까지 확장
      // 연관된 Type Dependency를 함께 수집
      const [deepCallGraph, typeDeps] = await Promise.all([
        this.callGraphBuilder.build(target, { maxDepth: 3 }),
        this.dependencyGraph.getTypeDependencies(target)
      ]);
      
      analysis.callGraph = deepCallGraph;
      analysis.typeDependencies = typeDeps;
    }
    
    // Ghost Symbol 발견 시 즉시 인터페이스 재구성
    if (analysis.ghostSymbols.length > 0) {
      const reconstructed = await this.symbolReconstructor.reconstruct(
        analysis.ghostSymbols
      );
      analysis.reconstructedInterfaces = reconstructed;
    }
    
    return analysis;
  }
}
```

### 4.2 Auto-Correction Strategy

에이전트의 불완전한 입력을 자동으로 보정합니다.

```typescript
// src/orchestration/strategies/AutoCorrectionStrategy.ts

export class AutoCorrectionStrategy {
  /**
   * Change (Edit) 고도화
   */
  async optimizeChangeRequest(
    request: ChangeRequest,
    context: OrchestrationContext
  ): Promise<CorrectedChangeRequest> {
    // Step 1: 먼저 exact 모드로 시도
    let dryRunResult = await this.editCoordinator.dryRun(request.edits, 'exact');
    
    // Step 2: 매칭 실패 시 정규화 모드 순차 적용
    if (!dryRunResult.success && dryRunResult.error === 'NO_MATCH') {
      const correctionModes = ['whitespace', 'structural', 'fuzzy'];
      
      for (const mode of correctionModes) {
        dryRunResult = await this.editCoordinator.dryRun(request.edits, mode);
        
        if (dryRunResult.success) {
          // 성공 시 에이전트에게 사용된 모드 알림
          return {
            ...request,
            correctedWith: mode,
            guidance: {
              message: `'${mode}' 모드로 매칭에 성공했습니다.`,
              recommendation: mode === 'fuzzy' 
                ? '정확한 타겟 문자열 확인을 권장합니다.'
                : null
            }
          };
        }
      }
      
      // 모든 모드 실패 시 상세 가이드 제공
      return {
        ...request,
        correctionFailed: true,
        guidance: {
          message: '모든 정규화 모드에서 매칭 실패',
          suggestedAction: {
            pillar: 'read',
            args: {
              target: request.targetFiles?.[0],
              view: 'fragment',
              lineRange: dryRunResult.suggestedLineRange
            }
          },
          reason: '대상 코드 블록의 정확한 내용을 먼저 확인하세요.'
        }
      };
    }
    
    return request;
  }
}
```

### 4.3 Caching Strategy

```typescript
// src/orchestration/strategies/CachingStrategy.ts

export class CachingStrategy {
  private workflowCache: LRUCache<string, WorkflowResult>;
  private resultCache: LRUCache<string, PillarResponse>;

  getCacheKey(pillar: string, args: any): string {
    return hash({
      pillar,
      args: this.normalizeArgs(args),
      projectHash: this.getProjectHash(),
      timestamp: Math.floor(Date.now() / 60000)  // 1분 TTL
    });
  }

  async getCachedOrExecute<T>(
    pillar: string,
    args: any,
    executor: () => Promise<T>
  ): Promise<T> {
    const key = this.getCacheKey(pillar, args);
    
    if (this.resultCache.has(key)) {
      return this.resultCache.get(key) as T;
    }
    
    const result = await executor();
    this.resultCache.set(key, result);
    return result;
  }
}
```

---

## 5. LLM-Friendly Insight Synthesis

### 5.1 Insight Data Structure

하위 도구들의 로우 데이터를 LLM 친화적인 **Insight JSON**으로 변환합니다.

```typescript
// src/orchestration/synthesis/InsightSynthesizer.ts

export interface Insight {
  type: 'architecture' | 'risk' | 'optimization' | 'maintenance' | 'dependency';
  severity: 'low' | 'medium' | 'high';
  observation: string;      // 발견된 사실 (What)
  implication: string;      // 이것이 의미하는 바 (Why it matters)
  risk?: string;            // 잠재적 리스크
  actionSuggestion: string; // 추천하는 다음 도구 호출
  affectedFiles: string[];
  confidence: number;       // 0-1
}

export interface SynthesizedInsights {
  // Overview Section
  overview: {
    filesAnalyzed: number;
    symbolsDiscovered: number;
    generatedAt: string;
    analysisDepth: string;
  };

  // PageRank Analysis
  pageRank: {
    topNodes: Array<{ 
      path: string; 
      symbol: string; 
      score: number; 
      role: 'core' | 'utility' | 'integration' | 'peripheral';
    }>;
    distribution: { 
      core: number; 
      utility: number; 
      integration: number; 
      peripheral: number; 
    };
  };

  // HotSpot Analysis
  hotSpots: {
    detected: HotSpot[];
    clusteredByFile: Map<string, HotSpot[]>;
    totalScore: number;
    riskSummary: string;
  };

  // Impact Summary
  impact: {
    highRiskFiles: string[];
    blastRadiusByFile: Map<string, number>;
    breakingChangeIndicators: string[];
  };

  // Actionable Insights
  insights: Insight[];
  
  // Visual Representation
  visualization?: string;  // Mermaid diagram
}
```

### 5.2 Insight Generation Rules

```typescript
// src/orchestration/synthesis/InsightRules.ts

export class InsightRules {
  /**
   * God Class/Module 감지
   */
  detectGodClass(pageRank: Map<string, number>, symbols: SymbolInfo[]): Insight | null {
    const highFanOutSymbols = Array.from(pageRank.entries())
      .filter(([_, score]) => score > 0.8);
    
    if (highFanOutSymbols.length > 0) {
      return {
        type: 'architecture',
        severity: 'high',
        observation: `${highFanOutSymbols.length}개의 심볼이 매우 높은 중심성을 보입니다.`,
        implication: '단일 책임 원칙(SRP) 위반 가능성이 있습니다.',
        risk: '수정 시 광범위한 영향, 테스트 커버리지 확보 어려움',
        actionSuggestion: 'understand({ goal: "해당 클래스의 책임 분석", depth: "deep" })',
        affectedFiles: highFanOutSymbols.map(([path]) => path.split('::')[0]),
        confidence: 0.85
      };
    }
    return null;
  }

  /**
   * 높은 변경 영향 범위 감지
   */
  detectHighBlastRadius(blastRadius: Map<string, number>): Insight | null {
    const highBlastFiles = Array.from(blastRadius.entries())
      .filter(([_, radius]) => radius > 10);
    
    if (highBlastFiles.length > 0) {
      return {
        type: 'risk',
        severity: 'high',
        observation: `${highBlastFiles.length}개의 파일이 10개 이상의 파일에 영향을 줍니다.`,
        implication: '이 파일들을 수정하면 광범위한 변경이 전파됩니다.',
        risk: '예상치 못한 사이드 이펙트, 회귀 버그 가능성',
        actionSuggestion: 'change({ intent: "...", options: { dryRun: true, includeImpact: true } })',
        affectedFiles: highBlastFiles.map(([path]) => path),
        confidence: 0.9
      };
    }
    return null;
  }

  /**
   * 순환 의존성 감지
   */
  detectCircularDependency(dependencies: DependencyEdge[]): Insight | null {
    const cycles = this.findCycles(dependencies);
    
    if (cycles.length > 0) {
      return {
        type: 'dependency',
        severity: 'medium',
        observation: `${cycles.length}개의 순환 의존성이 발견되었습니다.`,
        implication: '빌드 순서 문제, 테스트 격리 어려움, 리팩토링 복잡성 증가',
        actionSuggestion: 'understand({ goal: "순환 의존성 원인 분석", scope: "module" })',
        affectedFiles: [...new Set(cycles.flat())],
        confidence: 0.95
      };
    }
    return null;
  }

  /**
   * HotSpot 집중 파일 감지
   */
  detectHotSpotConcentration(hotSpots: HotSpot[]): Insight | null {
    const hotSpotsByFile = new Map<string, number>();
    hotSpots.forEach(hs => {
      hotSpotsByFile.set(hs.filePath, (hotSpotsByFile.get(hs.filePath) || 0) + 1);
    });
    
    const concentratedFiles = Array.from(hotSpotsByFile.entries())
      .filter(([_, count]) => count >= 3);
    
    if (concentratedFiles.length > 0) {
      return {
        type: 'maintenance',
        severity: 'medium',
        observation: `${concentratedFiles.length}개의 파일에 HotSpot이 집중되어 있습니다.`,
        implication: '이 파일들은 자주 수정되는 핫존으로, 버그 발생 확률이 높습니다.',
        actionSuggestion: '테스트 커버리지 강화 및 리팩토링 고려',
        affectedFiles: concentratedFiles.map(([path]) => path),
        confidence: 0.8
      };
    }
    return null;
  }
}
```

### 5.3 Visualization Generation

```typescript
// src/orchestration/synthesis/VisualizationGenerator.ts

export class VisualizationGenerator {
  generateMermaidDiagram(
    pageRank: Map<string, number>,
    hotSpots: HotSpot[],
    dependencies: DependencyEdge[]
  ): string {
    const topNodes = this.extractTopNodes(pageRank, 15);
    const hotSpotFiles = new Set(hotSpots.map(hs => hs.filePath));

    let mermaid = 'graph TD\n';
    mermaid += '  subgraph Legend\n';
    mermaid += '    L1[Core]:::core\n';
    mermaid += '    L2[HotSpot]:::hotspot\n';
    mermaid += '    L3[Integration]:::integration\n';
    mermaid += '  end\n\n';
    
    // Nodes
    topNodes.forEach(node => {
      const isHotSpot = hotSpotFiles.has(node.path);
      const style = isHotSpot ? ':::hotspot' : 
                    node.role === 'core' ? ':::core' : 
                    node.role === 'integration' ? ':::integration' : '';
      const label = `${this.truncate(node.symbol, 20)}\\n[${node.role}]`;
      mermaid += `  ${this.sanitizeId(node.path)}["${label}"]${style}\n`;
    });

    // Edges (dependencies)
    const relevantDeps = dependencies.filter(d => 
      topNodes.some(n => n.path === d.from || n.path === d.to)
    );
    
    relevantDeps.slice(0, 30).forEach(dep => {
      mermaid += `  ${this.sanitizeId(dep.from)} --> ${this.sanitizeId(dep.to)}\n`;
    });

    mermaid += '\n  classDef hotspot fill:#ff6b6b,stroke:#c92a2a\n';
    mermaid += '  classDef core fill:#4ecdc4,stroke:#099268\n';
    mermaid += '  classDef integration fill:#ffd43b,stroke:#fab005\n';

    return mermaid;
  }
}
```

---

## 6. Interactive Guidance System

### 6.1 Guidance API Specification

```typescript
// src/orchestration/guidance/GuidanceAPI.ts

/**
 * Guidance API: 에이전트에게 최적의 다음 행동을 제안
 */

export interface GuidancePayload {
  // 현재 컨텍스트 요약
  contextSummary: string;
  
  // 추천 행동 목록 (우선순위순)
  suggestedActions: SuggestedAction[];
  
  // 경고/주의사항
  warnings: Warning[];
  
  // 복구 전략 (오류 발생 시)
  recoveryStrategies?: RecoveryStrategy[];
  
  // 메타데이터
  meta: GuidanceMeta;
}

export interface SuggestedAction {
  priority: 1 | 2 | 3;        // 1 = 최우선
  pillar: IntentCategory;
  action: string;
  description: string;
  rationale: string;          // 왜 이 행동을 제안하는지
  
  // 바로 실행 가능한 Tool Call
  toolCall: {
    tool: string;
    args: Record<string, unknown>;
  };
  
  // 예상 결과
  expectedOutcome: string;
  
  // 조건부 실행
  condition?: string;
}

export interface Warning {
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
  affectedTargets: string[];
  mitigation?: string;
}

export interface GuidanceMeta {
  generatedAt: string;
  basedOn: {
    hotSpotCount: number;
    pageRankCoverage: number;
    impactAnalysisIncluded: boolean;
  };
  confidence: number;
}
```

### 6.2 Guidance Generator

```typescript
// src/orchestration/guidance/GuidanceGenerator.ts

export class GuidanceGenerator {
  /**
   * Heuristic Rules for Guidance Generation
   */
  private readonly rules: GuidanceRule[] = [
    // Rule 1: Dead End Recovery
    {
      name: 'DEAD_END',
      condition: (ctx) => ctx.lastResult?.output?.results?.length === 0,
      generate: (ctx) => ({
        priority: 1,
        pillar: 'navigate',
        action: 'retry',
        description: '검색 결과가 없습니다. 다른 검색 모드를 시도합니다.',
        rationale: '정확한 매칭이 실패했습니다.',
        toolCall: {
          tool: 'navigate',
          args: { 
            target: ctx.lastIntent.target,
            context: 'all'  // broader search
          }
        },
        expectedOutcome: '더 넓은 범위에서 관련 코드 발견'
      })
    },
    
    // Rule 2: High Risk Warning
    {
      name: 'HIGH_RISK',
      condition: (ctx) => (ctx.impactReport?.breakingChangeRisk === 'high'),
      generate: (ctx) => ({
        priority: 1,
        pillar: 'read',
        action: 'verify',
        description: '리스크가 높습니다. 영향받는 파일을 먼저 확인하세요.',
        rationale: `${ctx.impactReport.affectedHotSpots.length}개의 핫스팟이 영향받습니다.`,
        toolCall: {
          tool: 'read',
          args: { 
            target: ctx.impactReport.preview.summary.impactedFiles[0],
            view: 'skeleton'
          }
        },
        expectedOutcome: '영향받는 코드 구조 파악'
      })
    },
    
    // Rule 3: Incomplete Context
    {
      name: 'MISSING_TESTS',
      condition: (ctx) => (
        ctx.lastPillar === 'understand' && 
        !ctx.hasReadTestFiles &&
        ctx.report?.architecturalRole === 'core'
      ),
      generate: (ctx) => ({
        priority: 1,
        pillar: 'navigate',
        action: 'find_tests',
        description: '핵심 모듈입니다. 관련 테스트를 먼저 확인하세요.',
        rationale: '수정 전 테스트 커버리지 확인이 필요합니다.',
        toolCall: {
          tool: 'navigate',
          args: { 
            target: ctx.currentTarget,
            context: 'tests'
          }
        },
        expectedOutcome: '관련 테스트 파일 목록'
      })
    },
    
    // Rule 4: Post-Change Verification
    {
      name: 'VERIFY_CHANGE',
      condition: (ctx) => (
        ctx.lastPillar === 'change' && 
        ctx.lastChangeSuccess
      ),
      generate: (ctx) => ([
        {
          priority: 1,
          pillar: 'read',
          action: 'verify',
          description: '변경된 파일 내용을 확인합니다.',
          rationale: '의도한 변경이 적용되었는지 검증',
          toolCall: {
            tool: 'read',
            args: { target: ctx.currentTarget, view: 'skeleton' }
          },
          expectedOutcome: '변경된 코드 구조 확인'
        },
        {
          priority: 2,
          pillar: 'manage',
          action: 'test',
          description: `추천 테스트 실행: ${ctx.suggestedTests?.slice(0, 3).join(', ')}`,
          rationale: 'Impact Analysis에서 식별된 영향받는 테스트',
          toolCall: {
            tool: 'manage',
            args: { command: 'test', targets: ctx.suggestedTests }
          },
          expectedOutcome: '테스트 통과 확인'
        }
      ])
    },
    
    // Rule 5: DryRun Success → Apply
    {
      name: 'APPLY_CHANGE',
      condition: (ctx) => (
        ctx.lastPillar === 'change' && 
        ctx.lastDryRunSuccess &&
        ctx.impactReport?.breakingChangeRisk !== 'high'
      ),
      generate: (ctx) => ({
        priority: 1,
        pillar: 'change',
        action: 'apply',
        description: 'DryRun 성공. 실제 변경을 적용할 준비가 되었습니다.',
        rationale: 'DryRun이 성공했으며 Impact가 수용 가능한 수준입니다.',
        toolCall: {
          tool: 'change',
          args: { 
            ...ctx.pendingChangeRequest,
            options: { ...ctx.pendingChangeRequest.options, dryRun: false }
          }
        },
        expectedOutcome: '파일 수정 완료 및 트랜잭션 ID 반환'
      })
    }
  ];

  public generate(context: OrchestratorState): GuidancePayload {
    const suggestedActions: SuggestedAction[] = [];
    const warnings: Warning[] = [];

    // Apply rules
    for (const rule of this.rules) {
      if (rule.condition(context)) {
        const actions = rule.generate(context);
        if (Array.isArray(actions)) {
          suggestedActions.push(...actions);
        } else {
          suggestedActions.push(actions);
        }
      }
    }

    // Add HotSpot warnings
    if (context.activeHotSpots?.length > 0) {
      warnings.push({
        severity: 'warning',
        code: 'HOTSPOT_AFFECTED',
        message: `${context.activeHotSpots.length}개의 핫스팟 영역이 영향받을 수 있습니다.`,
        affectedTargets: context.activeHotSpots.map(hs => hs.filePath),
        mitigation: 'change pillar 호출 시 dryRun=true로 먼저 검증하세요.'
      });
    }

    // Sort by priority
    suggestedActions.sort((a, b) => a.priority - b.priority);

    return {
      contextSummary: this.buildContextSummary(context),
      suggestedActions: suggestedActions.slice(0, 5),
      warnings,
      recoveryStrategies: context.lastError ? this.buildRecoveryStrategies(context.lastError) : undefined,
      meta: {
        generatedAt: new Date().toISOString(),
        basedOn: {
          hotSpotCount: context.activeHotSpots?.length ?? 0,
          pageRankCoverage: context.pageRankCoverage ?? 0,
          impactAnalysisIncluded: context.lastImpactReport !== null
        },
        confidence: this.calculateConfidence(context)
      }
    };
  }

  private buildRecoveryStrategies(error: ErrorContext): RecoveryStrategy[] {
    const strategies: RecoveryStrategy[] = [];

    switch (error.code) {
      case 'NO_MATCH':
        strategies.push({
          name: 'Refresh Content',
          description: '대상 텍스트 블록을 정확히 확인합니다.',
          toolCall: {
            tool: 'read',
            args: { 
              target: error.target,
              view: 'fragment',
              lineRange: error.suggestedLineRange
            }
          }
        });
        break;

      case 'HASH_MISMATCH':
        strategies.push({
          name: 'Reload File',
          description: '파일이 외부에서 변경되었습니다. 최신 상태를 확인합니다.',
          toolCall: {
            tool: 'read',
            args: { target: error.target, view: 'full' }
          }
        });
        break;

      case 'INDEX_STALE':
        strategies.push({
          name: 'Rebuild Index',
          description: '인덱스가 오래되었습니다. 재구축을 권장합니다.',
          toolCall: {
            tool: 'manage',
            args: { command: 'rebuild', scope: 'incremental' }
          }
        });
        break;
    }

    return strategies;
  }
}
```

---

## 7. Pillar Implementation Details

### 7.1 UNDERSTAND Pillar

```typescript
// src/orchestration/pillars/UnderstandPillar.ts

export class UnderstandPillar {
  constructor(
    private readonly searchEngine: SearchEngine,
    private readonly skeletonGenerator: SkeletonGenerator,
    private readonly skeletonCache: SkeletonCache,
    private readonly callGraphBuilder: CallGraphBuilder,
    private readonly dependencyGraph: DependencyGraph,
    private readonly hotSpotDetector: HotSpotDetector,
    private readonly impactAnalyzer: ImpactAnalyzer,
    private readonly insightSynthesizer: InsightSynthesizer,
    private readonly guidanceGenerator: GuidanceGenerator
  ) {}

  public async execute(request: UnderstandRequest): Promise<UnderstandResponse> {
    const context = new OrchestrationContext();
    const targetFiles = await this.resolveTarget(request.goal);
    const depth = request.depth ?? 'standard';
    
    // 1. Eager Loading: 병렬로 모든 필요 데이터 수집
    const [
      skeletons,
      symbols,
      callGraphs,
      dependencies,
      hotSpots,
      pageRankScores
    ] = await Promise.all([
      this.loadSkeletons(targetFiles, depth),
      this.loadSymbols(targetFiles),
      request.include?.callGraph !== false ? this.loadCallGraphs(targetFiles, depth) : null,
      request.include?.dependencies !== false ? this.loadDependencies(targetFiles) : [],
      request.include?.hotSpots !== false ? this.hotSpotDetector.detectHotSpots() : [],
      request.include?.pageRank !== false ? this.loadPageRankScores(targetFiles) : new Map()
    ]);

    // 2. Synthesize Report
    const report = this.insightSynthesizer.synthesize({
      skeletons,
      symbols,
      callGraphs,
      dependencies,
      hotSpots,
      pageRankScores
    });

    // 3. Generate Guidance
    context.setReport(report);
    context.setTarget(targetFiles[0]);
    const guidance = this.guidanceGenerator.generate(context.getState());

    return {
      summary: report.overview,
      skeleton: skeletons.join('\n\n---\n\n'),
      symbols: symbols.flat(),
      callGraph: callGraphs?.[0],
      dependencies: dependencies.flat(),
      hotSpots,
      pageRankScores,
      impactRadius: this.calculateImpactRadius(dependencies),
      report,
      guidance,
      internalToolsUsed: context.getToolsUsed()
    };
  }

  private inferArchitecturalRole(
    avgPageRank: number, 
    deps: DependencyEdge[]
  ): 'core' | 'utility' | 'integration' | 'peripheral' {
    const fanIn = deps.filter(d => d.type === 'import').length;
    const fanOut = deps.filter(d => d.type === 'export').length;
    
    if (avgPageRank > 0.7 && fanIn > 10) return 'core';
    if (fanIn > 5 && fanOut < 3) return 'integration';
    if (fanOut > 5 && fanIn < 3) return 'utility';
    return 'peripheral';
  }
}
```

### 7.2 CHANGE Pillar

```typescript
// src/orchestration/pillars/ChangePillar.ts

export class ChangePillar {
  constructor(
    private readonly editCoordinator: EditCoordinator,
    private readonly impactAnalyzer: ImpactAnalyzer,
    private readonly searchEngine: SearchEngine,
    private readonly hotSpotDetector: HotSpotDetector,
    private readonly skeletonCache: SkeletonCache,
    private readonly autoCorrectionStrategy: AutoCorrectionStrategy,
    private readonly guidanceGenerator: GuidanceGenerator
  ) {}

  public async execute(request: ChangeRequest): Promise<ChangeResponse> {
    const context = new OrchestrationContext();
    const { targetFiles, edits, options = {} } = request;
    const { dryRun = true, includeImpact = true } = options;

    // 1. Auto-correction 적용
    const correctedRequest = await this.autoCorrectionStrategy.optimizeChangeRequest(
      request, context
    );
    
    if (correctedRequest.correctionFailed) {
      return {
        success: false,
        rollbackAvailable: false,
        guidance: correctedRequest.guidance
      };
    }

    // 2. DryRun 검증
    const dryRunResult = await this.editCoordinator.applyEdits(
      correctedRequest.targetFiles?.[0] ?? '', 
      correctedRequest.edits ?? [], 
      true
    );
    
    if (!dryRunResult.success) {
      return this.buildFailureResponse(dryRunResult, correctedRequest, context);
    }

    // 3. Impact Analysis (병렬)
    const [impactReport] = await Promise.all([
      includeImpact ? this.analyzeImpact(correctedRequest) : null
    ]);

    // 4. 실제 적용 (dryRun=false일 때만)
    let editResult: EditResult | undefined;
    if (!dryRun) {
      editResult = await this.editCoordinator.applyEdits(
        correctedRequest.targetFiles?.[0] ?? '',
        correctedRequest.edits ?? [],
        false,
        { diffMode: 'patience' }
      );

      // Cache Invalidation
      if (editResult.success) {
        await this.skeletonCache.invalidate(correctedRequest.targetFiles?.[0] ?? '');
        await this.searchEngine.invalidateFile(correctedRequest.targetFiles?.[0] ?? '');
      }
    }

    // 5. Guidance 생성
    context.setImpactReport(impactReport);
    context.setLastPillar('change');
    context.setDryRunSuccess(dryRunResult.success);
    const guidance = this.guidanceGenerator.generate(context.getState());

    return {
      success: dryRunResult.success,
      plan: dryRun ? {
        steps: this.buildPlanSteps(dryRunResult),
      } : undefined,
      impactReport,
      editResult: !dryRun ? editResult : undefined,
      transactionId: editResult?.operation?.id,
      rollbackAvailable: !dryRun && (editResult?.success ?? false),
      guidance
    };
  }

  private async analyzeImpact(request: ChangeRequest): Promise<ImpactReport> {
    const [preview, hotSpots] = await Promise.all([
      this.impactAnalyzer.analyzeImpact(request.targetFiles?.[0] ?? '', request.edits ?? []),
      this.hotSpotDetector.detectHotSpots()
    ]);

    const affectedHotSpots = hotSpots.filter(hs => 
      preview.summary.impactedFiles.includes(hs.filePath)
    );

    return {
      preview,
      affectedHotSpots,
      pageRankDelta: new Map(),
      breakingChangeRisk: this.assessBreakingChangeRisk(preview, affectedHotSpots),
      suggestedTests: preview.suggestedTests,
      testPriority: this.prioritizeTests(preview.suggestedTests, affectedHotSpots)
    };
  }

  private assessBreakingChangeRisk(
    preview: ImpactPreview, 
    affectedHotSpots: HotSpot[]
  ): 'none' | 'low' | 'medium' | 'high' {
    if (preview.riskLevel === 'high' && affectedHotSpots.length > 0) return 'high';
    if (preview.riskLevel === 'high' || affectedHotSpots.length > 2) return 'medium';
    if (preview.riskLevel === 'medium' || affectedHotSpots.length > 0) return 'low';
    return 'none';
  }
}
```

---

## 8. Tool Surface & Migration

### 8.1 New Tool Definition

```typescript
// src/tools/pillars.ts

export const PILLAR_TOOLS = {
  understand: {
    name: 'understand',
    description: `코드 구조를 심층 분석하고 통합 보고서를 생성합니다.
    
포함 정보:
- Skeleton (구조 요약)
- Call Graph (호출 관계)
- Dependencies (의존성)
- HotSpots (주요 진입점)
- PageRank Scores (아키텍처 중요도)
- Synthesized Report (통합 인사이트)
- Guidance (다음 행동 제안)`,
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '분석 목표 (자연어). e.g., "UserService의 인증 로직 파악"'
        },
        scope: {
          type: 'string',
          enum: ['symbol', 'file', 'module', 'project'],
          default: 'symbol',
          description: '분석 범위'
        },
        depth: {
          type: 'string',
          enum: ['shallow', 'standard', 'deep'],
          default: 'standard',
          description: '분석 깊이'
        },
        include: {
          type: 'object',
          properties: {
            callGraph: { type: 'boolean', default: true },
            hotSpots: { type: 'boolean', default: true },
            pageRank: { type: 'boolean', default: true },
            dependencies: { type: 'boolean', default: true }
          },
          description: '포함할 분석 데이터'
        }
      },
      required: ['goal']
    }
  },

  change: {
    name: 'change',
    description: `코드를 안전하게 수정합니다.
    
특징:
- 자동 DryRun 검증 (기본값: true)
- Impact Analysis 포함
- ACID 트랜잭션 보장
- 자동 롤백 지원
- Auto-Correction (whitespace, structural 정규화)
- 추천 테스트 제안`,
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: '변경 의도 (자연어). e.g., "validateEmail 함수에 도메인 체크 추가"'
        },
        targetFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '대상 파일 경로 (선택)'
        },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              lineRange: { type: 'string' },
              targetString: { type: 'string' },
              replacementString: { type: 'string' }
            }
          },
          description: '명시적 편집 목록 (선택)'
        },
        options: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', default: true },
            includeImpact: { type: 'boolean', default: true },
            autoRollback: { type: 'boolean', default: true }
          }
        }
      },
      required: ['intent']
    }
  },

  navigate: {
    name: 'navigate',
    description: `특정 코드 위치를 찾습니다.
    
특징:
- 자연어 또는 구체적 식별자 검색
- PageRank/HotSpot 정보 포함
- 단일 결과 시 Smart Profile 자동 포함 (Eager Loading)`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '검색 대상 (자연어 또는 식별자)'
        },
        context: {
          type: 'string',
          enum: ['definitions', 'usages', 'tests', 'docs', 'all'],
          default: 'all',
          description: '검색 컨텍스트'
        },
        limit: {
          type: 'number',
          default: 10,
          description: '결과 제한'
        }
      },
      required: ['target']
    }
  },

  read: {
    name: 'read',
    description: `파일 내용을 효율적으로 읽습니다.
    
특징:
- Smart File Profile 포함
- Cached Skeleton 활용
- 라인 범위 지정 가능`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '파일 경로 또는 심볼명'
        },
        view: {
          type: 'string',
          enum: ['full', 'skeleton', 'fragment'],
          default: 'skeleton',
          description: '보기 모드'
        },
        lineRange: {
          type: 'array',
          items: { type: 'number' },
          description: 'fragment 모드 시 라인 범위 [start, end]'
        },
        includeProfile: {
          type: 'boolean',
          default: true,
          description: 'Smart File Profile 포함 여부'
        }
      },
      required: ['target']
    }
  },

  write: {
    name: 'write',
    description: `새 파일을 생성하거나 스캐폴딩합니다.`,
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: '생성 의도 (자연어)'
        },
        targetPath: {
          type: 'string',
          description: '생성할 파일 경로 (선택)'
        },
        template: {
          type: 'string',
          description: '템플릿 이름 (선택)'
        },
        content: {
          type: 'string',
          description: '직접 제공할 내용 (선택)'
        }
      },
      required: ['intent']
    }
  },

  manage: {
    name: 'manage',
    description: `프로젝트 상태를 관리합니다.
    
명령어:
- status: 프로젝트 상태 확인
- undo: 변경 롤백
- redo: 롤백 취소
- rebuild: 인덱스 재구축
- test: 테스트 실행
- history: 변경 이력 조회`,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['status', 'undo', 'redo', 'rebuild', 'test', 'history'],
          description: '실행할 명령'
        },
        scope: {
          type: 'string',
          enum: ['file', 'transaction', 'project'],
          description: '명령 범위 (선택)'
        },
        target: {
          type: 'string',
          description: '대상 (undo/redo 시 트랜잭션 ID)'
        }
      },
      required: ['command']
    }
  }
};
```

### 8.2 Internal Tool Registry

```typescript
// src/orchestration/InternalToolRegistry.ts

export class InternalToolRegistry {
  // 기존 40+ 도구를 내부적으로 유지
  private tools: Map<string, InternalTool> = new Map();
  
  constructor() {
    // 기존 도구들 등록 (변경 없음)
    this.register("read_code", new ReadCodeTool());
    this.register("search_project", new SearchProjectTool());
    this.register("analyze_relationship", new AnalyzeRelationshipTool());
    this.register("edit_code", new EditCodeTool());
    this.register("list_directory", new ListDirectoryTool());
    this.register("get_hierarchy", new GetHierarchyTool());
    // ... 40+ 도구
  }
  
  /**
   * OrchestrationEngine에서만 접근 가능
   */
  async execute(toolName: string, args: unknown): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) throw new ToolNotFoundError(toolName);
    return tool.execute(args);
  }
}
```

### 8.3 Migration Strategy

```typescript
// Phase 1: 경고 추가 + Pillar 도구 병행 (Month 1-2)
export async function read_code(args: ReadCodeArgs): Promise<ReadCodeResult> {
  logger.warn({
    code: "TOOL_DEPRECATED",
    message: "read_code is deprecated. Use read pillar instead.",
    migration: "read({ target: filePath, view: 'skeleton' })"
  });
  
  return internalReadCode(args);
}

// Phase 2: 레거시 도구 자동 변환 (Month 3)
export class LegacyToolAdapter {
  adapt(legacyCall: LegacyToolCall): PillarToolCall {
    const mappings: Record<string, (args: any) => PillarToolCall> = {
      "read_code": (args) => ({
        pillar: "read",
        args: { 
          target: args.filePath,
          view: args.view ?? 'skeleton',
          lineRange: args.lineRange
        }
      }),
      "search_project": (args) => ({
        pillar: "navigate",
        args: { target: args.query }
      }),
      "analyze_relationship": (args) => ({
        pillar: "understand",
        args: { 
          goal: `Analyze ${args.target}`,
          scope: 'symbol'
        }
      }),
      "edit_code": (args) => ({
        pillar: "change",
        args: {
          intent: "Edit file",
          targetFiles: [args.filePath],
          edits: args.edits
        }
      })
    };
    
    return mappings[legacyCall.tool]?.(legacyCall.args);
  }
}

// Phase 3: 레거시 도구 제거 (Month 4+)
// 기존 도구 MCP 노출 제거, 내부적으로만 유지
```

### 8.4 Simplified Playbook

**새로운 지침서 (~600줄)**:

```markdown
# Agent Playbook: Six Pillars

## Quick Reference

| 목적 | Pillar | 예시 |
|------|--------|------|
| 코드 이해 | `understand` | `understand({ goal: "인증 로직 파악" })` |
| 코드 수정 | `change` | `change({ intent: "검증 로직 추가", options: { dryRun: true } })` |
| 코드 탐색 | `navigate` | `navigate({ target: "PaymentService" })` |
| 파일 읽기 | `read` | `read({ target: "src/auth.ts", view: "skeleton" })` |
| 파일 생성 | `write` | `write({ intent: "테스트 파일 생성" })` |
| 상태 관리 | `manage` | `manage({ command: "undo", target: "tx-123" })` |

## Workflow Patterns

### Pattern 1: 코드 분석 → 수정
1. `understand({ goal: "수정할 코드 파악" })`
2. `change({ intent: "변경 내용", options: { dryRun: true } })`
3. Review impact report
4. `change({ intent: "변경 내용", options: { dryRun: false } })`

### Pattern 2: 버그 수정
1. `navigate({ target: "에러 메시지 또는 심볼" })`
2. `understand({ goal: "버그 원인 분석", depth: "deep" })`
3. `change({ intent: "버그 수정", options: { dryRun: true } })`

## Guidance 활용
- 모든 응답에 `guidance` 필드가 포함됩니다
- `suggestedActions`: 다음 행동 제안 (우선순위순)
- `warnings`: 주의사항
- `toolCall`: 바로 실행 가능한 도구 호출 정보
```

---

## 9. Performance & Success Metrics

### 9.1 Performance Overhead

| 구성요소 | 예상 오버헤드 | 최적화 전략 |
|---------|-------------|------------|
| Intent Detection | ~5ms | 캐시된 패턴 매칭 |
| Workflow Planning | ~10ms | 템플릿 기반 O(1) 조회 |
| Eager Loading | ~100ms | 병렬 실행 + 캐시 활용 |
| Insight Synthesis | ~30ms | 규칙 기반 빠른 추론 |
| Guidance Generation | ~15ms | Heuristic 규칙 엔진 |
| **Total Overhead** | **~160ms** | 내부 도구 실행 대비 수용 가능 |

### 9.2 Quantitative Success Metrics

| 지표 | 현재 Baseline | 목표 | 측정 방법 |
|------|-------------|------|----------|
| **평균 Turn 수** | 6.2 turns/task | ≤2.0 turns | MCP 호출 로그 분석 |
| **토큰 소모** | 5,000 tokens/task | ≤1,500 tokens | 토큰 카운터 |
| **작업 성공률** | 75% first-attempt | ≥90% | 에이전트 테스트 스위트 |
| **지침서 크기** | 8,000줄 | ≤600줄 | 라인 카운트 |
| **Auto-Correction 성공률** | N/A | ≥80% | 정규화 모드 적용 로그 |

### 9.3 Qualitative Metrics

- **에이전트 피드백**: "도구 선택이 쉬워졌다" 응답 ≥80%
- **개발자 유지보수**: 도구 업데이트 시 지침서 수정 ≤10줄
- **오류 복구**: Guidance 제안 수락률 ≥70%

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- [ ] `OrchestrationEngine` 및 `OrchestrationContext` 구현
- [ ] `IntentRouter` 기본 키워드/정규식 분류 엔진 구축
- [ ] `InternalToolRegistry` 기존 40개 도구 브릿지 연동
- [ ] `WorkflowPlanner` 템플릿 기반 계획 수립

### Phase 2: Core Pillars (Week 3-4)
- [ ] `UnderstandPillar` 구현 (Eager Loading 포함)
- [ ] `ChangePillar` 구현 (Auto-Correction 포함)
- [ ] `NavigatePillar` 구현 (Smart Profile 자동 확장)
- [ ] `ReadPillar`, `WritePillar`, `ManagePillar` 구현

### Phase 3: Intelligence Layer (Week 5-6)
- [ ] `InsightSynthesizer` 구현 (PageRank, HotSpot, Impact 통합)
- [ ] `GuidanceGenerator` 규칙 엔진 구축
- [ ] `AutoCorrectionStrategy` 구현
- [ ] `EagerLoadingStrategy` 구현

### Phase 4: Integration & Polish (Week 7-8)
- [ ] MCP Tool Surface 마이그레이션
- [ ] `LegacyToolAdapter` 호환성 레이어 구현
- [ ] 성능 최적화 (캐싱, 병렬화)
- [ ] 테스트 커버리지 확보 (≥80%)
- [ ] Agent Playbook 문서화

---

## 11. Risks & Mitigations

| 리스크 | 영향 | 완화 전략 |
|--------|------|----------|
| **Intent 오인식** | 잘못된 워크플로우 실행 | 신뢰도 점수 노출 + Guidance로 확인 유도 |
| **오버엔지니어링** | 단순 작업에 불필요한 오버헤드 | `depth: "shallow"` 옵션으로 경량 실행 |
| **디버깅 어려움** | 내부 도구 호출 추적 불가 | `internalToolsUsed` 필드로 투명성 확보 |
| **마이그레이션 충격** | 기존 워크플로우 중단 | 4개월 deprecation 기간 + 어댑터 레이어 |
| **Eager Loading 오버헤드** | 불필요한 데이터 로드 | `include` 옵션으로 선택적 로드 |

---

## 12. Alternatives Considered

### 12.1 Option A: 도구 수만 줄이기 (ADR-020 방식)

**장점**: 구현 단순  
**단점**: 에이전트가 여전히 5개 도구의 순서/조합을 결정해야 함  
**결론**: 인지 부하 감소 효과 제한적 → 기각

### 12.2 Option B: 완전 자연어 인터페이스

**장점**: 최소 인지 부하  
**단점**: 예측 불가능한 동작, 테스트 어려움, 토큰 과소비  
**결론**: 너무 불명확함 → 기각

### 12.3 Option C: Six Pillars Architecture (선택됨)

**장점**: 
- 목적 중심 추상화로 인지 부하 최소화
- 내부 오케스트레이션으로 최적 실행 보장
- 기존 도구 재사용으로 안정성 확보
- 대화형 가이던스로 에이전트 지원

**단점**: 
- 초기 구현 복잡도
- 오케스트레이션 로직 유지보수

**결론**: 제약조건 모두 충족 → 선택

---

## 13. Conclusion

Six Pillars Architecture는:

1. **인지 부하 최소화**: 40+ → 6개 도구, 자연어 인터페이스
2. **토큰 효율성 극대화**: 평균 70% 토큰 감소, 71% Turn 감소
3. **하위 호환성 유지**: 기존 40개 도구 내부 재사용
4. **지침서 단순화**: 92% 크기 감소, 도구별 업데이트 영향 격리
5. **대화형 가이던스**: 맥락 기반 다음 단계 제안
6. **자동 최적화**: Eager Loading, Auto-Correction 전략
7. **LLM 친화적 인사이트**: 구조화된 Insight JSON + Mermaid 시각화

이 아키텍처는 에이전트가 **"무엇을 하고 싶은지(What)"**만 표현하면, 시스템이 **"어떻게 할지(How)"**를 자동으로 결정하는 **목적 중심 추상화**를 제공합니다.

---

## Appendix A: Workflow Templates

### A.1 Understand Templates

```yaml
understand.explore_symbol:
  steps:
    - tool: search_project
      params: { query: "${intent.subject}", type: "symbol" }
    - tool: read_code
      params: { view: "skeleton" }
      input_from: step1.results[0].filePath
    - tool: analyze_relationship
      params: { mode: "calls", direction: "both", maxDepth: 3 }
      input_from: step1.results[0]
    - tool: hotspot_detector
      params: {}
      parallel: true
    - tool: read_code
      params: { view: "fragment" }
      input_from: step3.hotMethods
      parallel: true

understand.explore_module:
  steps:
    - tool: list_directory
      params: { path: "${intent.subject}" }
    - tool: analyze_relationship
      params: { mode: "dependencies", direction: "both" }
      input_from: step1.files
      parallel: true
    - tool: read_code
      params: { view: "skeleton" }
      input_from: step1.files
      parallel: true
      limit: 10

understand.analyze_deep:
  # PageRank 상위 5%일 때 자동 확장
  condition: "${pageRank} > 0.95"
  steps:
    - tool: call_graph_builder
      params: { maxDepth: 3 }
    - tool: dependency_graph
      params: { includeTypes: true }
      parallel: true
```

### A.2 Change Templates

```yaml
change.modify_function:
  steps:
    - tool: search_project
      params: { query: "${intent.subject}", type: "symbol" }
    - tool: read_code
      params: { view: "full" }
      input_from: step1.results[0].filePath
    - tool: impact_analyzer
      params: {}
      input_from: step1.results[0]
      parallel: true
    - tool: hotspot_detector
      params: {}
      parallel: true
    - tool: edit_coordinator
      params: { dryRun: "${args.options.dryRun}" }
      computed: true

change.batch_edit:
  steps:
    - tool: search_project
      params: { query: "${intent.subject}", type: "symbol" }
      batch: true
    - tool: read_code
      params: { view: "full" }
      input_from: step1.results
      parallel: true
    - tool: edit_coordinator
      params: { batchMode: true, dryRun: "${args.options.dryRun}" }
```

### A.3 Navigate Templates

```yaml
navigate.find_definition:
  steps:
    - tool: search_project
      params: { query: "${args.target}", type: "symbol" }
    - tool: read_code
      params: { view: "fragment", lineRange: "context" }
      input_from: step1.results
      limit: 5
      parallel: true
  eager_expansion:
    condition: step1.results.length === 1
    additional:
      - tool: file_profiler
        params: {}
      - tool: skeleton_cache
        params: {}

navigate.find_usages:
  steps:
    - tool: search_project
      params: { query: "${args.target}", type: "code" }
    - tool: read_code
      params: { view: "fragment" }
      input_from: step1.results
      limit: 10
      parallel: true

navigate.find_tests:
  steps:
    - tool: search_project
      params: { query: "${args.target}", type: "file", pattern: "*.test.*" }
    - tool: read_code
      params: { view: "skeleton" }
      input_from: step1.results
      parallel: true
```

---

## Appendix B: Intent Classification Rules

```typescript
const INTENT_RULES = {
  // Explore intent markers
  explore: {
    keywords: ["구조", "아키텍처", "관계", "의존성", "어떻게", "무엇", "파악", "이해"],
    patterns: [/어떻게.*구성/, /구조.*파악/, /의존.*관계/, /아키텍처.*분석/],
    confidence_boost: 0.2
  },
  
  // Locate intent markers
  locate: {
    keywords: ["어디", "위치", "찾기", "정의", "사용처", "호출", "검색"],
    patterns: [/어디.*정의/, /찾아.*줘/, /사용.*되는/, /호출.*하는/],
    confidence_boost: 0.15
  },
  
  // Analyze intent markers
  analyze: {
    keywords: ["분석", "영향", "리스크", "변경", "호출 체인", "데이터 흐름"],
    patterns: [/영향.*분석/, /리스크.*평가/, /변경.*시/, /호출.*체인/],
    confidence_boost: 0.25
  },
  
  // Modify intent markers
  modify: {
    keywords: ["수정", "추가", "삭제", "변경", "리팩토링", "업데이트", "고치"],
    patterns: [/추가.*해줘/, /수정.*하고/, /변경.*해/, /리팩토링/],
    confidence_boost: 0.3
  },
  
  // Read intent markers
  read: {
    keywords: ["읽", "보여", "내용", "코드", "확인"],
    patterns: [/내용.*확인/, /코드.*보여/, /파일.*읽/],
    confidence_boost: 0.1
  },
  
  // Create intent markers
  create: {
    keywords: ["생성", "만들", "새로", "작성", "스캐폴딩"],
    patterns: [/파일.*생성/, /새로.*만들/, /테스트.*작성/],
    confidence_boost: 0.2
  },
  
  // Manage intent markers
  manage: {
    keywords: ["롤백", "되돌", "상태", "히스토리", "재구축"],
    patterns: [/되돌려.*줘/, /상태.*확인/, /인덱스.*재구축/],
    confidence_boost: 0.15
  }
};

// Confidence calculation
function calculateConfidence(matches: PatternMatch[]): number {
  let confidence = 0.5; // base confidence
  
  for (const match of matches) {
    const rule = INTENT_RULES[match.category];
    confidence += rule.confidence_boost;
    
    // Pattern match is stronger than keyword
    if (match.type === 'pattern') {
      confidence += 0.1;
    }
  }
  
  return Math.min(confidence, 1.0);
}
```

---

## Appendix C: Guidance Rule Examples

```typescript
// Complete Guidance Rule Set

const GUIDANCE_RULES: GuidanceRule[] = [
  // === Recovery Rules ===
  {
    name: 'NO_MATCH_RECOVERY',
    priority: 1,
    condition: (ctx) => ctx.lastError?.code === 'NO_MATCH',
    action: {
      pillar: 'read',
      description: '대상 코드 블록의 정확한 내용을 확인합니다.',
      generateArgs: (ctx) => ({
        target: ctx.lastError.target,
        view: 'fragment',
        lineRange: ctx.lastError.suggestedLineRange
      })
    }
  },
  
  {
    name: 'HASH_MISMATCH_RECOVERY',
    priority: 1,
    condition: (ctx) => ctx.lastError?.code === 'HASH_MISMATCH',
    action: {
      pillar: 'read',
      description: '파일이 외부에서 변경되었습니다. 최신 내용을 확인합니다.',
      generateArgs: (ctx) => ({
        target: ctx.lastError.target,
        view: 'full'
      })
    },
    warning: {
      severity: 'warning',
      message: '파일이 외부에서 수정되었을 수 있습니다.'
    }
  },

  // === Workflow Continuation Rules ===
  {
    name: 'UNDERSTAND_TO_CHANGE',
    priority: 2,
    condition: (ctx) => ctx.lastPillar === 'understand' && ctx.currentTarget,
    action: {
      pillar: 'change',
      description: '분석이 완료되었습니다. 변경 사항을 적용할 준비가 되었습니다.',
      generateArgs: (ctx) => ({
        intent: `Modify ${ctx.currentTarget}`,
        targetFiles: [ctx.currentTarget],
        options: { dryRun: true, includeImpact: true }
      })
    }
  },

  {
    name: 'DRYRUN_TO_APPLY',
    priority: 1,
    condition: (ctx) => (
      ctx.lastPillar === 'change' &&
      ctx.lastDryRunSuccess &&
      ctx.impactReport?.breakingChangeRisk !== 'high'
    ),
    action: {
      pillar: 'change',
      description: 'DryRun 성공. 실제 변경을 적용합니다.',
      generateArgs: (ctx) => ({
        ...ctx.pendingChangeRequest,
        options: { ...ctx.pendingChangeRequest.options, dryRun: false }
      })
    }
  },

  {
    name: 'CHANGE_TO_VERIFY',
    priority: 1,
    condition: (ctx) => ctx.lastPillar === 'change' && ctx.lastChangeSuccess,
    action: {
      pillar: 'read',
      description: '변경된 파일 내용을 확인합니다.',
      generateArgs: (ctx) => ({
        target: ctx.currentTarget,
        view: 'skeleton'
      })
    }
  },

  // === Safety Rules ===
  {
    name: 'HIGH_RISK_WARNING',
    priority: 1,
    condition: (ctx) => ctx.impactReport?.breakingChangeRisk === 'high',
    action: {
      pillar: 'understand',
      description: '리스크가 높습니다. 영향받는 파일을 먼저 분석하세요.',
      generateArgs: (ctx) => ({
        goal: `Analyze impact on ${ctx.impactReport.affectedHotSpots[0]?.filePath}`,
        depth: 'deep'
      })
    },
    warning: {
      severity: 'critical',
      message: `${ctx.impactReport.affectedHotSpots.length}개의 핫스팟이 영향받습니다.`
    }
  },

  {
    name: 'MISSING_TESTS_WARNING',
    priority: 2,
    condition: (ctx) => (
      ctx.lastPillar === 'understand' &&
      !ctx.hasReadTestFiles &&
      ctx.report?.architecturalRole === 'core'
    ),
    action: {
      pillar: 'navigate',
      description: '핵심 모듈입니다. 관련 테스트를 먼저 확인하세요.',
      generateArgs: (ctx) => ({
        target: ctx.currentTarget,
        context: 'tests'
      })
    }
  }
];
```

---

## Appendix D: Current Stack Integration

| 기존 컴포넌트 | 통합 위치 | 활용 방식 |
|-------------|----------|----------|
| **SearchEngine (HybridScoring, IntentDetection)** | `IntentRouter`, `NavigatePillar` | 의도 감지 + 검색 실행 |
| **EditCoordinator (ACID, DryRun)** | `ChangePillar` | 안전한 편집 실행 |
| **SkeletonGenerator (Semantic Summary, Cache)** | `UnderstandPillar`, `ReadPillar` | 구조 요약 생성 |
| **ImpactAnalyzer** | `ChangePillar`, `InsightSynthesizer` | 변경 영향 분석 |
| **HotSpotDetector** | `InsightSynthesizer`, `GuidanceGenerator` | 핫스팟 감지 + 경고 |
| **CallGraphBuilder** | `UnderstandPillar` | 호출 관계 분석 |
| **DependencyGraph** | `UnderstandPillar`, `InsightSynthesizer` | 의존성 분석 |

---

**Document History:**
- 2025-12-19: Initial unified specification (merged from ADR-006 + ADR-033 concept)
- Status: Approved for implementation
