# ADR-006: Intelligent Orchestration Layer (IOL)

| 속성        | 값                                        |
| ----------- | ----------------------------------------- |
| 상태        | **Superseded by ADR-033**                 |
| 날짜        | 2024-12-19                                |
| 의사결정자  | Architecture Team                         |
| 관련 ADR    | ADR-003 (SearchEngine), ADR-004 (EditCoordinator) |
| 후속 ADR    | **ADR-033 (Six Pillars Architecture)**    |

> ⚠️ **이 문서는 ADR-033에 의해 대체되었습니다.**  
> ADR-033은 이 문서의 개념을 발전시켜 6대 기둥(Six Pillars) 아키텍처로 확장하고,  
> Eager Loading, Auto-Correction, LLM 친화적 Insight Synthesis 등의 상세 구현 명세를 포함합니다.  
> 최신 기술 명세는 [ADR-033-Six-Pillars-Architecture.md](./ADR-033-Six-Pillars-Architecture.md)를 참조하세요.

---

## 1. Context (배경)

### 1.1 문제 정의

현재 에이전트(LLM)가 smart-context-mcp의 저수준 도구들을 사용할 때 다음과 같은 문제가 발생합니다:

```
[현재 흐름 - 7~10 Turn]
Agent → search_project("handleAuth") 
     → read_code(file1, skeleton)
     → read_code(file1, fragment)
     → analyze_relationship(symbol, dependencies)
     → analyze_relationship(symbol, calls)
     → edit_code(...)
     → read_code(verify)
```

**핵심 문제점:**
1. **추론 품질 저하**: 매 턴마다 어떤 도구를 호출할지 결정하느라 핵심 작업에 집중하지 못함
2. **토큰 낭비**: 중복된 컨텍스트 설명, 도구 호출 오버헤드, 중간 결과 파싱
3. **오류 복구 실패**: 저수준 오류(NO_MATCH, HASH_MISMATCH)에서 최적 복구 전략 선택 어려움
4. **분석 데이터 미활용**: PageRank, HotSpot, Impact 등 풍부한 메타데이터가 별도 호출 필요

### 1.2 목표

```
[목표 흐름 - 1~2 Turn]
Agent → understand("handleAuth 인증 로직 파악") 
     ← { skeleton, callGraph, hotSpots, dependencies, nextActions }

Agent → change("handleAuth에 rate limiting 추가", { impact: true })
     ← { editResult, impactReport, suggestedTests, rollbackId }
```

---

## 2. Decision (결정)

### 2.1 아키텍처 개요

**6대 기둥(Pillar) 기반 Intelligent Orchestration Layer** 도입

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Intelligent Orchestration Layer                       │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │UNDERSTAND│  │  CHANGE  │  │ NAVIGATE │  │   READ   │  │  WRITE   │  │
│  │  Pillar  │  │  Pillar  │  │  Pillar  │  │  Pillar  │  │  Pillar  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │             │             │             │             │         │
│  ┌────┴─────────────┴─────────────┴─────────────┴─────────────┴────┐   │
│  │                    Intent Router & Orchestrator                  │   │
│  └────┬─────────────┬─────────────┬─────────────┬─────────────┬────┘   │
│       │             │             │             │             │         │
│  ┌──────────┐                                                          │
│  │  MANAGE  │     ← 6번째 기둥: 프로젝트/세션 관리                      │
│  │  Pillar  │                                                          │
│  └──────────┘                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                         Core Infrastructure                              │
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

### 2.2 6대 기둥 정의

| 기둥 | 역할 | 주요 의도(Intent) | 기존 컴포넌트 활용 |
|------|------|-------------------|-------------------|
| **UNDERSTAND** | 코드 구조/의미 파악 | `comprehend`, `explain`, `analyze` | SearchEngine, SkeletonGenerator, CallGraphBuilder |
| **CHANGE** | 안전한 코드 수정 | `add`, `modify`, `remove`, `refactor` | EditCoordinator, ImpactAnalyzer |
| **NAVIGATE** | 심볼/의존성 탐색 | `find`, `trace`, `jump` | DependencyGraph, SymbolIndex |
| **READ** | 최적화된 파일 읽기 | `view`, `preview`, `diff` | SkeletonCache, FileProfiler |
| **WRITE** | 파일 생성/관리 | `create`, `template`, `scaffold` | EditorEngine, TransactionLog |
| **MANAGE** | 프로젝트 상태 관리 | `status`, `undo`, `rebuild` | HistoryEngine, IncrementalIndexer |

---

## 3. Detailed Design (상세 설계)

### 3.1 Intent Router

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
  depth?: number;           // 분석 깊이
  scope?: 'file' | 'symbol' | 'project';
  includeImpact?: boolean;
  dryRun?: boolean;
  eagerLoad?: EagerLoadConfig;
}

export interface EagerLoadConfig {
  skeleton: boolean;
  callGraph: boolean;
  dependencies: boolean;
  hotSpots: boolean;
  pageRank: boolean;
}

export class IntentRouter {
  private readonly intentPatterns: Map<RegExp, IntentCategory>;
  private readonly queryIntentDetector: QueryIntentDetector;

  constructor(queryIntentDetector: QueryIntentDetector) {
    this.queryIntentDetector = queryIntentDetector;
    this.intentPatterns = this.buildIntentPatterns();
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

  private buildIntentPatterns(): Map<RegExp, IntentCategory> {
    return new Map([
      // UNDERSTAND
      [/\b(이해|파악|분석|설명|comprehend|understand|explain|analyze)\b/i, 'understand'],
      [/\b(구조|아키텍처|structure|architecture)\b/i, 'understand'],
      
      // CHANGE  
      [/\b(수정|변경|추가|삭제|리팩토링|modify|change|add|remove|refactor)\b/i, 'change'],
      [/\b(fix|bug|issue|에러|버그)\b/i, 'change'],
      
      // NAVIGATE
      [/\b(찾|검색|추적|점프|find|search|trace|jump|goto)\b/i, 'navigate'],
      [/\b(어디|where|which|호출|사용|used|called)\b/i, 'navigate'],
      
      // READ
      [/\b(읽|보|미리보기|view|read|preview|show)\b/i, 'read'],
      [/\b(diff|비교|compare)\b/i, 'read'],
      
      // WRITE
      [/\b(생성|만들|작성|create|write|generate|scaffold)\b/i, 'write'],
      [/\b(template|boilerplate|새\s*파일)\b/i, 'write'],
      
      // MANAGE
      [/\b(상태|되돌리|다시|undo|redo|status|rebuild|index)\b/i, 'manage'],
    ]);
  }

  private detectCategory(intent: string): IntentCategory {
    for (const [pattern, category] of this.intentPatterns) {
      if (pattern.test(intent)) {
        return category;
      }
    }
    // 기존 QueryIntentDetector 활용한 폴백
    const queryIntent = this.queryIntentDetector.detect(intent);
    return this.mapQueryIntentToCategory(queryIntent);
  }

  private mapQueryIntentToCategory(queryIntent: QueryIntent): IntentCategory {
    switch (queryIntent) {
      case 'symbol': return 'navigate';
      case 'file': return 'read';
      case 'bug': return 'change';
      case 'code': 
      default: return 'understand';
    }
  }
}
```

### 3.2 UNDERSTAND Pillar (핵심 예시)

```typescript
// src/orchestration/pillars/UnderstandPillar.ts

export interface UnderstandRequest {
  target: string;           // 파일 경로, 심볼명, 또는 자연어 쿼리
  depth?: 'shallow' | 'standard' | 'deep';
  includeCallGraph?: boolean;
  includeHotSpots?: boolean;
  includePageRank?: boolean;
}

export interface UnderstandResponse {
  // Core Understanding
  skeleton: string;
  symbols: SymbolInfo[];
  
  // Relationship Analysis (Eager Loaded)
  callGraph?: CallGraphResult;
  dependencies: DependencyEdge[];
  
  // Intelligence Layer
  hotSpots: HotSpot[];
  pageRankScores: Map<string, number>;
  impactRadius: number;       // 변경 시 영향 범위
  
  // Synthesized Report
  report: SynthesizedReport;
  
  // Guidance API
  guidance: GuidancePayload;
}

export interface SynthesizedReport {
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

export class UnderstandPillar {
  constructor(
    private readonly searchEngine: SearchEngine,
    private readonly skeletonGenerator: SkeletonGenerator,
    private readonly skeletonCache: SkeletonCache,
    private readonly callGraphBuilder: CallGraphBuilder,
    private readonly dependencyGraph: DependencyGraph,
    private readonly hotSpotDetector: HotSpotDetector,
    private readonly impactAnalyzer: ImpactAnalyzer
  ) {}

  public async execute(request: UnderstandRequest): Promise<UnderstandResponse> {
    const targetFiles = await this.resolveTarget(request.target);
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
      request.includeCallGraph !== false ? this.loadCallGraphs(targetFiles, depth) : null,
      this.loadDependencies(targetFiles),
      request.includeHotSpots !== false ? this.hotSpotDetector.detectHotSpots() : [],
      request.includePageRank !== false ? this.loadPageRankScores(targetFiles) : new Map()
    ]);

    // 2. Synthesize Report
    const report = this.synthesizeReport({
      skeletons,
      symbols,
      callGraphs,
      dependencies,
      hotSpots,
      pageRankScores
    });

    // 3. Generate Guidance
    const guidance = this.generateGuidance(request, report);

    return {
      skeleton: skeletons.join('\n\n---\n\n'),
      symbols: symbols.flat(),
      callGraph: callGraphs?.[0],
      dependencies: dependencies.flat(),
      hotSpots,
      pageRankScores,
      impactRadius: this.calculateImpactRadius(dependencies),
      report,
      guidance
    };
  }

  private synthesizeReport(data: {
    skeletons: string[];
    symbols: SymbolInfo[][];
    callGraphs: CallGraphResult[] | null;
    dependencies: DependencyEdge[][];
    hotSpots: HotSpot[];
    pageRankScores: Map<string, number>;
  }): SynthesizedReport {
    const allSymbols = data.symbols.flat();
    const allDeps = data.dependencies.flat();
    
    // PageRank 기반 아키텍처 역할 판단
    const avgPageRank = this.calculateAvgPageRank(data.pageRankScores);
    const architecturalRole = this.inferArchitecturalRole(avgPageRank, allDeps);
    
    // HotSpot 기반 리스크 식별
    const risks = this.identifyRisks(data.hotSpots, data.pageRankScores);
    
    return {
      summary: this.generateSummary(allSymbols, architecturalRole),
      architecturalRole,
      complexity: {
        loc: this.estimateLOC(data.skeletons),
        branches: this.countBranches(allSymbols),
        dependencies: allDeps.length,
        fanIn: allDeps.filter(d => d.type === 'import').length,
        fanOut: allDeps.filter(d => d.type === 'export').length
      },
      risks,
      recommendations: this.generateRecommendations(risks, architecturalRole)
    };
  }

  private inferArchitecturalRole(
    avgPageRank: number, 
    deps: DependencyEdge[]
  ): SynthesizedReport['architecturalRole'] {
    const fanIn = deps.filter(d => d.type === 'import').length;
    const fanOut = deps.filter(d => d.type === 'export').length;
    
    if (avgPageRank > 0.7 && fanIn > 10) return 'core';
    if (fanIn > 5 && fanOut < 3) return 'integration';
    if (fanOut > 5 && fanIn < 3) return 'utility';
    return 'peripheral';
  }
}
```

### 3.3 CHANGE Pillar

```typescript
// src/orchestration/pillars/ChangePillar.ts

export interface ChangeRequest {
  description: string;        // 자연어 변경 의도
  target: string;             // 파일/심볼
  edits?: Edit[];             // 명시적 편집 (선택)
  options?: {
    dryRun?: boolean;
    includeImpact?: boolean;
    autoRollback?: boolean;
    batchMode?: boolean;
  };
}

export interface ChangeResponse {
  success: boolean;
  editResult: EditResult;
  
  // Impact Analysis (Eager Loaded when includeImpact=true)
  impactReport?: ImpactReport;
  
  // Transaction Management
  transactionId: string;
  rollbackAvailable: boolean;
  
  // Guidance
  guidance: GuidancePayload;
}

export interface ImpactReport {
  // 기존 ImpactPreview 확장
  preview: ImpactPreview;
  
  // 통합 분석 데이터
  affectedHotSpots: HotSpot[];
  pageRankDelta: Map<string, number>;  // 변경 전후 PageRank 변화 예측
  breakingChangeRisk: 'none' | 'low' | 'medium' | 'high';
  
  // 추천 테스트
  suggestedTests: string[];
  testPriority: Map<string, 'critical' | 'important' | 'optional'>;
}

export class ChangePillar {
  constructor(
    private readonly editCoordinator: EditCoordinator,
    private readonly impactAnalyzer: ImpactAnalyzer,
    private readonly searchEngine: SearchEngine,
    private readonly hotSpotDetector: HotSpotDetector,
    private readonly skeletonCache: SkeletonCache
  ) {}

  public async execute(request: ChangeRequest): Promise<ChangeResponse> {
    const { target, edits, options = {} } = request;
    const { dryRun = false, includeImpact = true } = options;

    // 1. DryRun으로 먼저 유효성 검증
    if (!dryRun) {
      const dryRunResult = await this.editCoordinator.applyEdits(
        target, 
        edits ?? [], 
        true  // dryRun
      );
      
      if (!dryRunResult.success) {
        return this.buildFailureResponse(dryRunResult, request);
      }
    }

    // 2. Impact Analysis (병렬 실행)
    const [impactReport, editResult] = await Promise.all([
      includeImpact ? this.analyzeImpact(target, edits ?? []) : null,
      dryRun 
        ? this.editCoordinator.applyEdits(target, edits ?? [], true)
        : this.editCoordinator.applyEdits(target, edits ?? [], false, { diffMode: 'patience' })
    ]);

    // 3. Skeleton Cache Invalidation
    if (!dryRun && editResult.success) {
      await this.skeletonCache.invalidate(target);
      await this.searchEngine.invalidateFile(target);
    }

    // 4. Generate Guidance
    const guidance = this.generateGuidance(request, editResult, impactReport);

    return {
      success: editResult.success,
      editResult,
      impactReport,
      transactionId: editResult.operation?.id ?? '',
      rollbackAvailable: !dryRun && editResult.success,
      guidance
    };
  }

  private async analyzeImpact(target: string, edits: Edit[]): Promise<ImpactReport> {
    const [preview, hotSpots] = await Promise.all([
      this.impactAnalyzer.analyzeImpact(target, edits),
      this.hotSpotDetector.detectHotSpots()
    ]);

    const affectedHotSpots = hotSpots.filter(hs => 
      preview.summary.impactedFiles.includes(hs.filePath)
    );

    const breakingChangeRisk = this.assessBreakingChangeRisk(preview, affectedHotSpots);
    const testPriority = this.prioritizeTests(preview.suggestedTests, affectedHotSpots);

    return {
      preview,
      affectedHotSpots,
      pageRankDelta: new Map(), // TODO: Implement PageRank delta calculation
      breakingChangeRisk,
      suggestedTests: preview.suggestedTests,
      testPriority
    };
  }

  private assessBreakingChangeRisk(
    preview: ImpactPreview, 
    affectedHotSpots: HotSpot[]
  ): ImpactReport['breakingChangeRisk'] {
    if (preview.riskLevel === 'high' && affectedHotSpots.length > 0) return 'high';
    if (preview.riskLevel === 'high' || affectedHotSpots.length > 2) return 'medium';
    if (preview.riskLevel === 'medium' || affectedHotSpots.length > 0) return 'low';
    return 'none';
  }
}
```

### 3.4 Guidance API 명세

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

export class GuidanceGenerator {
  constructor(
    private readonly workflowPatterns: typeof AGENT_WORKFLOW_PATTERNS
  ) {}

  public generate(
    currentState: OrchestratorState,
    lastResult: any,
    errorContext?: ErrorContext
  ): GuidancePayload {
    const suggestedActions: SuggestedAction[] = [];
    const warnings: Warning[] = [];

    // 1. 오류 복구 전략
    if (errorContext) {
      const recovery = this.buildRecoveryActions(errorContext);
      suggestedActions.push(...recovery.actions);
      if (recovery.warnings) warnings.push(...recovery.warnings);
    }

    // 2. 컨텍스트 기반 다음 행동 추론
    const contextActions = this.inferNextActions(currentState, lastResult);
    suggestedActions.push(...contextActions);

    // 3. HotSpot 기반 경고
    if (currentState.activeHotSpots.length > 0) {
      warnings.push({
        severity: 'warning',
        code: 'HOTSPOT_AFFECTED',
        message: `${currentState.activeHotSpots.length}개의 핫스팟 영역이 영향받을 수 있습니다.`,
        affectedTargets: currentState.activeHotSpots.map(hs => hs.filePath),
        mitigation: 'change pillar 호출 시 dryRun=true로 먼저 검증하세요.'
      });
    }

    // 4. 우선순위 정렬
    suggestedActions.sort((a, b) => a.priority - b.priority);

    return {
      contextSummary: this.buildContextSummary(currentState),
      suggestedActions: suggestedActions.slice(0, 5), // Top 5
      warnings,
      recoveryStrategies: errorContext ? this.mapToRecoveryStrategies(errorContext) : undefined,
      meta: {
        generatedAt: new Date().toISOString(),
        basedOn: {
          hotSpotCount: currentState.activeHotSpots.length,
          pageRankCoverage: currentState.pageRankCoverage,
          impactAnalysisIncluded: currentState.lastImpactReport !== null
        },
        confidence: this.calculateConfidence(currentState)
      }
    };
  }

  private inferNextActions(
    state: OrchestratorState, 
    lastResult: any
  ): SuggestedAction[] {
    const actions: SuggestedAction[] = [];

    // UNDERSTAND 후 → CHANGE 제안
    if (state.lastPillar === 'understand' && state.currentTarget) {
      actions.push({
        priority: 1,
        pillar: 'change',
        action: 'modify',
        description: `${state.currentTarget}에 변경 사항 적용`,
        rationale: '코드 구조 분석이 완료되었으므로 안전하게 수정할 수 있습니다.',
        toolCall: {
          tool: 'change',
          args: { 
            target: state.currentTarget,
            options: { dryRun: true, includeImpact: true }
          }
        },
        expectedOutcome: 'DryRun 결과와 Impact Report 확인'
      });
    }

    // CHANGE (dryRun) 후 → 실제 적용 또는 취소
    if (state.lastPillar === 'change' && state.lastDryRunSuccess) {
      actions.push({
        priority: 1,
        pillar: 'change',
        action: 'apply',
        description: 'DryRun 결과가 양호합니다. 실제 변경을 적용하시겠습니까?',
        rationale: 'DryRun이 성공했으며 Impact가 수용 가능한 수준입니다.',
        toolCall: {
          tool: 'change',
          args: { 
            target: state.currentTarget,
            edits: state.pendingEdits,
            options: { dryRun: false }
          }
        },
        expectedOutcome: '파일 수정 완료 및 트랜잭션 ID 반환'
      });
    }

    // CHANGE 성공 후 → 검증 제안
    if (state.lastPillar === 'change' && state.lastChangeSuccess) {
      actions.push({
        priority: 1,
        pillar: 'read',
        action: 'verify',
        description: '변경된 파일 내용을 확인합니다.',
        rationale: '수정 후 의도한 변경이 적용되었는지 검증이 필요합니다.',
        toolCall: {
          tool: 'read',
          args: { 
            target: state.currentTarget,
            view: 'skeleton'
          }
        },
        expectedOutcome: '변경된 코드 구조 확인'
      });

      // 테스트 실행 제안
      if (state.suggestedTests.length > 0) {
        actions.push({
          priority: 2,
          pillar: 'manage',
          action: 'test',
          description: `추천 테스트 실행: ${state.suggestedTests.slice(0, 3).join(', ')}`,
          rationale: 'Impact Analysis에서 식별된 영향받는 테스트입니다.',
          toolCall: {
            tool: 'manage',
            args: { 
              command: 'test',
              targets: state.suggestedTests
            }
          },
          expectedOutcome: '테스트 결과 확인'
        });
      }
    }

    return actions;
  }

  private buildRecoveryActions(error: ErrorContext): { 
    actions: SuggestedAction[]; 
    warnings?: Warning[] 
  } {
    const actions: SuggestedAction[] = [];
    const warnings: Warning[] = [];

    switch (error.code) {
      case 'NO_MATCH':
        actions.push({
          priority: 1,
          pillar: 'read',
          action: 'fragment',
          description: '대상 텍스트 블록을 정확히 확인합니다.',
          rationale: '편집 대상을 찾지 못했습니다. 정확한 라인 범위를 확인하세요.',
          toolCall: {
            tool: 'read',
            args: { 
              target: error.target,
              view: 'fragment',
              lineRange: error.suggestedLineRange
            }
          },
          expectedOutcome: '정확한 대상 텍스트 확인'
        });
        break;

      case 'HASH_MISMATCH':
        actions.push({
          priority: 1,
          pillar: 'read',
          action: 'refresh',
          description: '파일이 외부에서 변경되었습니다. 최신 상태를 확인합니다.',
          rationale: '파일 해시가 불일치합니다. 최신 내용으로 다시 계획하세요.',
          toolCall: {
            tool: 'read',
            args: { 
              target: error.target,
              view: 'full'
            }
          },
          expectedOutcome: '최신 파일 내용 및 해시 확인'
        });
        warnings.push({
          severity: 'warning',
          code: 'CONCURRENT_MODIFICATION',
          message: '파일이 외부에서 수정되었을 수 있습니다.',
          affectedTargets: [error.target],
          mitigation: '최신 내용을 확인 후 편집 계획을 다시 수립하세요.'
        });
        break;

      case 'INDEX_STALE':
        actions.push({
          priority: 1,
          pillar: 'manage',
          action: 'rebuild',
          description: '인덱스가 오래되었습니다. 재구축을 권장합니다.',
          rationale: '의존성/심볼 정보가 최신이 아닙니다.',
          toolCall: {
            tool: 'manage',
            args: { command: 'rebuild', scope: 'incremental' }
          },
          expectedOutcome: '인덱스 갱신 완료'
        });
        break;
    }

    return { actions, warnings };
  }
}
```

### 3.5 통합 보고서 합성 (Synthesizer)

```typescript
// src/orchestration/synthesis/ReportSynthesizer.ts

export interface IntegratedReport {
  // Overview
  overview: {
    filesAnalyzed: number;
    symbolsDiscovered: number;
    generatedAt: string;
  };

  // PageRank Analysis
  pageRank: {
    topNodes: Array<{ path: string; symbol: string; score: number; role: string }>;
    distribution: { core: number; utility: number; integration: number; peripheral: number };
  };

  // HotSpot Analysis
  hotSpots: {
    detected: HotSpot[];
    clusteredByFile: Map<string, HotSpot[]>;
    totalScore: number;
  };

  // Impact Summary
  impact: {
    highRiskFiles: string[];
    blastRadiusByFile: Map<string, number>;
    breakingChangeIndicators: string[];
  };

  // Actionable Insights
  insights: Insight[];
  
  // Visual Representation (ASCII or Mermaid)
  visualization?: string;
}

export interface Insight {
  type: 'architecture' | 'risk' | 'optimization' | 'maintenance';
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  affectedFiles: string[];
  recommendation: string;
}

export class ReportSynthesizer {
  constructor(
    private readonly hotSpotDetector: HotSpotDetector,
    private readonly impactAnalyzer: ImpactAnalyzer,
    private readonly callGraphBuilder: CallGraphBuilder,
    private readonly dependencyGraph: DependencyGraph
  ) {}

  public async synthesize(scope: string[]): Promise<IntegratedReport> {
    // 1. 병렬 데이터 수집
    const [hotSpots, pageRankData, dependencyData] = await Promise.all([
      this.hotSpotDetector.detectHotSpots(),
      this.computePageRankForScope(scope),
      this.collectDependencyData(scope)
    ]);

    // 2. 통합 분석
    const clusteredHotSpots = this.clusterHotSpots(hotSpots);
    const distribution = this.computeRoleDistribution(pageRankData);
    const blastRadius = this.computeBlastRadius(dependencyData);
    const insights = this.generateInsights(hotSpots, pageRankData, blastRadius);

    // 3. 시각화 생성
    const visualization = this.generateMermaidDiagram(pageRankData, hotSpots);

    return {
      overview: {
        filesAnalyzed: scope.length,
        symbolsDiscovered: pageRankData.size,
        generatedAt: new Date().toISOString()
      },
      pageRank: {
        topNodes: this.extractTopNodes(pageRankData, 20),
        distribution
      },
      hotSpots: {
        detected: hotSpots,
        clusteredByFile: clusteredHotSpots,
        totalScore: hotSpots.reduce((sum, hs) => sum + hs.score, 0)
      },
      impact: {
        highRiskFiles: this.identifyHighRiskFiles(hotSpots, pageRankData),
        blastRadiusByFile: blastRadius,
        breakingChangeIndicators: this.detectBreakingChangeIndicators(dependencyData)
      },
      insights,
      visualization
    };
  }

  private generateInsights(
    hotSpots: HotSpot[],
    pageRank: Map<string, number>,
    blastRadius: Map<string, number>
  ): Insight[] {
    const insights: Insight[] = [];

    // God Class Detection
    const highFanOutSymbols = Array.from(pageRank.entries())
      .filter(([_, score]) => score > 0.8);
    
    if (highFanOutSymbols.length > 0) {
      insights.push({
        type: 'architecture',
        severity: 'high',
        title: 'God Class/Module 감지',
        description: `${highFanOutSymbols.length}개의 심볼이 매우 높은 중심성을 보입니다.`,
        affectedFiles: highFanOutSymbols.map(([path]) => path.split('::')[0]),
        recommendation: '단일 책임 원칙에 따라 분리를 고려하세요.'
      });
    }

    // High Blast Radius Warning
    const highBlastFiles = Array.from(blastRadius.entries())
      .filter(([_, radius]) => radius > 10);
    
    if (highBlastFiles.length > 0) {
      insights.push({
        type: 'risk',
        severity: 'high',
        title: '높은 변경 영향 범위',
        description: `${highBlastFiles.length}개의 파일이 10개 이상의 파일에 영향을 줍니다.`,
        affectedFiles: highBlastFiles.map(([path]) => path),
        recommendation: '이 파일들 수정 시 반드시 Impact Analysis를 수행하세요.'
      });
    }

    // HotSpot Concentration
    const hotSpotsByFile = new Map<string, number>();
    hotSpots.forEach(hs => {
      hotSpotsByFile.set(hs.filePath, (hotSpotsByFile.get(hs.filePath) || 0) + 1);
    });
    
    const concentratedFiles = Array.from(hotSpotsByFile.entries())
      .filter(([_, count]) => count >= 3);
    
    if (concentratedFiles.length > 0) {
      insights.push({
        type: 'maintenance',
        severity: 'medium',
        title: 'HotSpot 집중 파일',
        description: `${concentratedFiles.length}개의 파일에 HotSpot이 집중되어 있습니다.`,
        affectedFiles: concentratedFiles.map(([path]) => path),
        recommendation: '이 파일들은 자주 수정되므로 테스트 커버리지를 강화하세요.'
      });
    }

    return insights;
  }

  private generateMermaidDiagram(
    pageRank: Map<string, number>,
    hotSpots: HotSpot[]
  ): string {
    const topNodes = this.extractTopNodes(pageRank, 10);
    const hotSpotFiles = new Set(hotSpots.map(hs => hs.filePath));

    let mermaid = 'graph TD\n';
    
    topNodes.forEach(node => {
      const isHotSpot = hotSpotFiles.has(node.path);
      const style = isHotSpot ? ':::hotspot' : (node.role === 'core' ? ':::core' : '');
      const label = `${node.symbol}\\n[${node.role}]`;
      mermaid += `  ${this.sanitizeId(node.path)}["${label}"]${style}\n`;
    });

    mermaid += '\n  classDef hotspot fill:#ff6b6b\n';
    mermaid += '  classDef core fill:#4ecdc4\n';

    return mermaid;
  }

  private sanitizeId(path: string): string {
    return path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
  }
}
```

---

## 4. Tool Surface 변경

### 4.1 신규 통합 도구

```typescript
// 기존 7개 도구 → 6개 Pillar 도구로 통합

// 기존
tools: [
  'search_project',      // → NAVIGATE, UNDERSTAND
  'analyze_relationship', // → UNDERSTAND, NAVIGATE  
  'read_code',           // → READ
  'edit_code',           // → CHANGE, WRITE
  'manage_project',      // → MANAGE
  'list_directory',      // → NAVIGATE
  'get_hierarchy'        // → NAVIGATE
]

// 신규 (6 Pillars)
tools: [
  // 고수준 Pillar 도구 (권장)
  'understand',          // 구조 파악 + 분석 데이터 통합
  'change',              // 안전한 수정 + Impact Report
  'navigate',            // 심볼/의존성 탐색
  'read',                // 최적화된 읽기
  'write',               // 생성/스캐폴딩
  'manage',              // 프로젝트 관리

  // 저수준 도구 (호환성 유지, deprecated warning)
  'search_project',      // → navigate로 대체 권장
  'analyze_relationship', // → understand로 대체 권장
  'read_code',           // → read로 대체 권장
  'edit_code',           // → change로 대체 권장
]
```

### 4.2 도구 정의 예시

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
        target: {
          type: 'string',
          description: '분석 대상 (파일 경로, 심볼명, 또는 자연어 쿼리)'
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
            report: { type: 'boolean', default: true }
          },
          description: '포함할 분석 데이터'
        }
      },
      required: ['target']
    }
  },

  change: {
    name: 'change',
    description: `코드를 안전하게 수정합니다.
    
특징:
- 자동 DryRun 검증
- Impact Analysis 포함
- ACID 트랜잭션 보장
- 자동 롤백 지원
- 추천 테스트 제안`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '수정할 파일 경로'
        },
        description: {
          type: 'string',
          description: '변경 의도 (자연어)'
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
          description: '명시적 편집 목록'
        },
        options: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', default: false },
            includeImpact: { type: 'boolean', default: true },
            autoRollback: { type: 'boolean', default: true }
          }
        }
      },
      required: ['target']
    }
  }
};
```

---

## 5. Implementation Plan (구현 계획)

### Phase 1: Foundation (Week 1-2)
- [ ] IntentRouter 구현
- [ ] Pillar 기본 인터페이스 정의
- [ ] 기존 컴포넌트 어댑터 작성

### Phase 2: Core Pillars (Week 3-4)
- [ ] UnderstandPillar 구현 (Eager Loading)
- [ ] ChangePillar 구현 (Impact Integration)
- [ ] GuidanceGenerator 구현

### Phase 3: Integration (Week 5-6)
- [ ] ReportSynthesizer 구현
- [ ] Tool Surface 마이그레이션
- [ ] 호환성 레이어 구현

### Phase 4: Polish (Week 7-8)
- [ ] 성능 최적화 (캐싱, 병렬화)
- [ ] 테스트 커버리지 확보
- [ ] 문서화

---

## 6. Consequences (결과)

### 6.1 장점

1. **토큰 효율**: 7~10턴 → 1~2턴 (70-80% 감소 예상)
2. **추론 품질**: 저수준 도구 선택 부담 제거, 핵심 작업 집중
3. **안전성**: 자동 DryRun, Impact Analysis, 트랜잭션 보장
4. **인사이트**: PageRank/HotSpot/Impact 통합 보고서
5. **가이던스**: 상황별 최적 다음 행동 제안

### 6.2 단점/리스크

1. **복잡성 증가**: 오케스트레이션 레이어 유지보수 부담
2. **학습 곡선**: 기존 도구에 익숙한 에이전트의 전환 비용
3. **오버헤드**: Eager Loading으로 인한 초기 지연 가능성

### 6.3 마이그레이션 전략

- 기존 도구는 `deprecated` 경고와 함께 유지
- 점진적 마이그레이션 가이드 제공
- `AgentPlaybook`에 Pillar 도구 우선 사용 권장 추가

---

## 7. References

- 기존 `AgentPlaybook.ts` 워크플로우 가이드
- `SearchEngine` Hybrid Scoring 로직
- `EditCoordinator` ACID 트랜잭션 패턴
- `ImpactAnalyzer` Risk Scoring 알고리즘
- `HotSpotDetector` 진입점 분석 로직
