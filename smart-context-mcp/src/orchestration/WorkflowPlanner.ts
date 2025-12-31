
import { IntentCategory, ParsedIntent } from './IntentRouter.js';


export interface WorkflowStep {
  id: string;
  tool: string;
  params: Record<string, any>;
  inputFrom?: string;      // 이전 단계의 결과 참조 (e.g., "step1.output.filePath")
  condition?: string;      // 실행 조건
  parallel?: boolean;      // 병렬 실행 가능 여부
}

export interface WorkflowPlan {
  steps: WorkflowStep[];
  parallelizableGroups: string[][]; // 병렬 실행 가능한 단계 ID 그룹
  parallelizable?: string[][];
  fallbacks?: FallbackStrategy[];
  eagerExpansions?: EagerExpansion[];
}

export interface FallbackStrategy {
  name: string;
  condition: string;
  steps: WorkflowStep[];
}

export interface EagerExpansion {
  trigger: string;
  steps: WorkflowStep[];
}

interface WorkflowTemplate {
  steps: WorkflowStep[];
  fallbacks?: FallbackStrategy[];
  eagerExpansions?: EagerExpansion[];
}

class WorkflowTemplateRegistry {
  constructor(private readonly stepBuilder: (intent: ParsedIntent) => WorkflowStep[]) {}

  public get(_operation: IntentCategory, intent: ParsedIntent): WorkflowTemplate {
    const steps = this.stepBuilder(intent);
    return {
      steps,
      fallbacks: this.buildFallbacks(intent),
      eagerExpansions: this.buildEagerExpansions(intent)
    };
  }

  private buildFallbacks(intent: ParsedIntent): FallbackStrategy[] {
    if (intent.category === 'navigate' || intent.category === 'understand') {
      return [{
        name: 'BROADEN_SEARCH',
        condition: 'search.output.results.length === 0',
        steps: [
          { id: 'fallback_search', tool: 'search_project', params: { query: intent.originalIntent } }
        ]
      }];
    }
    return [];
  }

  private buildEagerExpansions(intent: ParsedIntent): EagerExpansion[] {
    if (intent.category === 'navigate') {
      return [{
        trigger: 'search.output.results.length === 1',
        steps: [
          { id: 'eager_profile', tool: 'file_profiler', params: {}, inputFrom: 'search.output.results[0].path' }
        ]
      }];
    }
    if (intent.category === 'understand') {
      return [{
        trigger: 'include.hotSpots === true',
        steps: [{ id: 'eager_hotspots', tool: 'hotspot_detector', params: {}, parallel: true }]
      }];
    }
    return [];
  }
}

/**
 * WorkflowPlanner: 의도에 맞춰 최적의 도구 실행 계획(Workflow)을 생성합니다.
 */
export class WorkflowPlanner {
  private readonly templates = new WorkflowTemplateRegistry((intent) => this.getTemplateSteps(intent));
  /**
   * 의도와 컨텍스트를 분석하여 실행 계획을 수립합니다.
   */
  public plan(intent: ParsedIntent): WorkflowPlan {
    const template = this.templates.get(intent.category, intent);
    const steps = template.steps;
    
    const plan: WorkflowPlan = {
      steps,
      parallelizableGroups: this.identifyParallelGroups(steps),
      parallelizable: this.identifyParallelGroups(steps),
      fallbacks: template.fallbacks ?? [],
      eagerExpansions: template.eagerExpansions ?? []
    };
    return plan;
  }

  private getTemplateSteps(intent: ParsedIntent): WorkflowStep[] {
    const { category, targets, constraints } = intent;
    const subject = targets[0] || '';

    switch (category) {
      case 'understand':
        return [
          { id: 'search', tool: 'search_project', params: { query: subject, type: 'symbol' } },
          { id: 'read_skeleton', tool: 'read_code', params: { view: 'skeleton' }, inputFrom: 'search.output.results[0].path' },
          { id: 'hotspots', tool: 'hotspot_detector', params: {}, parallel: true }
        ];

      case 'change':
        return [
          { id: 'search', tool: 'search_project', params: { query: subject, type: 'symbol' } },
          { id: 'read_full', tool: 'read_code', params: { view: 'full' }, inputFrom: 'search.output.results[0].path' },
          { id: 'impact', tool: 'impact_analyzer', params: {}, inputFrom: 'search.output.results[0].path', parallel: true },
          { id: 'dry_run', tool: 'edit_coordinator', params: { dryRun: true, edits: constraints.edits || [] }, inputFrom: 'search.output.results[0].path' }
        ];

      case 'navigate':
        return [
          { id: 'search', tool: 'search_project', params: { query: subject, limit: constraints.limit || 10 } },
          { id: 'profile', tool: 'file_profiler', params: {}, inputFrom: 'search.output.results[0].path', condition: 'search.output.results.length === 1' }
        ];

      case 'read':
        return [
          { id: 'read', tool: 'read_code', params: { filePath: subject, view: constraints.depth === 'deep' ? 'full' : 'skeleton', lineRange: constraints.lineRange } }
        ];

      case 'write':
      case 'manage':
        return [];

      default:
        // 최소한의 검색 및 읽기 계획
        return [
          { id: 'search', tool: 'search_project', params: { query: subject } }
        ];
    }
  }

  private identifyParallelGroups(steps: WorkflowStep[]): string[][] {
    const groups: string[][] = [];
    let currentGroup: string[] = [];

    for (const step of steps) {
      if (step.parallel) {
        currentGroup.push(step.id);
      } else {
        if (currentGroup.length > 0) groups.push(currentGroup);
        groups.push([step.id]);
        currentGroup = [];
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    return groups;
  }
}
