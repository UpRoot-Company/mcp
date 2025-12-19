
import { IntentRouter, ParsedIntent } from './IntentRouter.js';
import { OrchestrationContext } from './OrchestrationContext.js';
import { WorkflowPlanner } from './WorkflowPlanner.js';
import { InternalToolRegistry } from './InternalToolRegistry.js';
import { UnderstandPillar } from './pillars/UnderstandPillar.js';
import { ChangePillar } from './pillars/ChangePillar.js';
import { NavigatePillar } from './pillars/NavigatePillar.js';
import { ReadPillar, WritePillar } from './pillars/BasePillars.js';
import { ManagePillar } from './pillars/ManagePillar.js';
import { InsightSynthesizer } from './InsightSynthesizer.js';
import { GuidanceGenerator } from './GuidanceGenerator.js';


export class OrchestrationEngine {
  private pillars: Map<string, any> = new Map();
  private synthesizer = new InsightSynthesizer();
  private guidanceGenerator = new GuidanceGenerator();

  constructor(
    private readonly intentRouter: IntentRouter,
    private readonly planner: WorkflowPlanner,
    private readonly registry: InternalToolRegistry
  ) {
    this.pillars.set('understand', new UnderstandPillar(registry));
    this.pillars.set('change', new ChangePillar(registry));
    this.pillars.set('navigate', new NavigatePillar(registry));
    this.pillars.set('read', new ReadPillar(registry));
    this.pillars.set('write', new WritePillar(registry));
    this.pillars.set('manage', new ManagePillar(registry));
  }

  /**
   * Processes a pillar request.
   */
  public async executePillar(category: string, args: any): Promise<any> {
    const context = new OrchestrationContext();
    const intent = typeof args === 'string' 
      ? this.intentRouter.parse(args)
      : this.mapArgsToIntent(category, args);

    const plan = this.planner.plan(intent);
    if (plan.steps.length > 0) {
      await this.executePlan(plan, context);
      return this.synthesizeResponse(intent, context);
    }

    const pillar = this.pillars.get(category);
    if (!pillar) {
      throw new Error(`Pillar not found: ${category}`);
    }

    const result = await pillar.execute(intent, context);

    const insights = this.synthesizer.synthesize({
      skeletons: result.structure ? [{ content: result.structure }] : [],
      calls: result.relationships?.calls,
      dependencies: result.relationships?.dependencies,
      hotSpots: result.impactReport?.hotSpots || []
    });

    const guidance = this.guidanceGenerator.generate({
      lastPillar: category,
      lastResult: result,
      insights: insights.insights
    });

    return {
      ...result,
      insights: insights.insights,
      visualization: insights.visualization,
      guidance
    };
  }

  private async executePlan(plan: { steps: any[]; parallelizableGroups: string[][] }, context: OrchestrationContext): Promise<void> {
    const stepMap = new Map(plan.steps.map(step => [step.id, step]));
    for (const group of plan.parallelizableGroups) {
      const executions = group.map(async (stepId) => {
        const step = stepMap.get(stepId);
        if (!step) return;
        if (step.condition && !this.evaluateCondition(step.condition, context)) {
          return;
        }
        const params = this.resolveParams(step.params, step.inputFrom, context);
        const started = Date.now();
        try {
          const output = await this.registry.execute(step.tool, params);
          context.addStep({
            id: step.id,
            tool: step.tool,
            args: params,
            output,
            status: 'success',
            duration: Date.now() - started
          });
        } catch (error: any) {
          context.addStep({
            id: step.id,
            tool: step.tool,
            args: params,
            output: { message: error?.message ?? 'Unknown error' },
            status: 'failure',
            duration: Date.now() - started
          });
          context.addError({
            code: error?.code ?? 'STEP_FAILED',
            message: error?.message ?? 'Step execution failed',
            tool: step.tool
          });
        }
      });
      await Promise.all(executions);
      if (context.getErrors().length > 0) {
        return;
      }
    }
  }



  private mapArgsToIntent(category: string, args: any): ParsedIntent {
    return {
      category: category as any,
      action: args.action || 'execute',
      targets: args.target ? [args.target] : (args.targetFiles || []),
      originalIntent: JSON.stringify(args),
      constraints: {
        ...(args.options || {}),
        edits: args.edits,
        view: args.view,
        lineRange: args.lineRange
      },
      confidence: 1.0
    };
  }


  private resolveParams(params: any, inputFrom: string | undefined, context: OrchestrationContext): any {
    let resolved = { ...params };
    if (inputFrom) {
      const value = context.resolveTemplate(`\${${inputFrom}}`);
      // 특정 규칙에 따라 병합 (예: filePath 필드 자동 채우기)
      if (typeof value === 'string') {
        if (!resolved.filePath) {
          resolved.filePath = value;
        }
        if (!resolved.target) {
          resolved.target = value;
        }
      } else if (typeof value === 'object' && value !== null) {
        resolved = { ...resolved, ...value };
        const pathValue = (value as any).path;
        if (pathValue && !resolved.filePath) {
          resolved.filePath = pathValue;
        }
        if (pathValue && !resolved.target) {
          resolved.target = pathValue;
        }
      }
    }
    return resolved;
  }

  private evaluateCondition(condition: string, context: OrchestrationContext): boolean {
    const trimmed = condition.trim();
    const match = trimmed.match(/^(.+?)\s*(===|==|!==|!=|>=|<=|>|<)\s*(.+)$/);
    if (match) {
      const [, leftExpr, operator, rightExpr] = match;
      const leftValue = context.resolveTemplate(`\${${leftExpr.trim()}}`);
      const rightValue = this.parseConditionValue(rightExpr.trim());
      switch (operator) {
        case '===': return leftValue === rightValue;
        case '==': return leftValue == rightValue;
        case '!==': return leftValue !== rightValue;
        case '!=': return leftValue != rightValue;
        case '>': return leftValue > rightValue;
        case '<': return leftValue < rightValue;
        case '>=': return leftValue >= rightValue;
        case '<=': return leftValue <= rightValue;
        default: return false;
      }
    }
    const value = context.resolveTemplate(`\${${trimmed}}`);
    return !!value && value !== `\${${trimmed}}`;
  }

  private parseConditionValue(raw: string): any {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const num = Number(raw);
    if (!Number.isNaN(num)) return num;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw;
  }

    private synthesizeResponse(intent: ParsedIntent, context: OrchestrationContext): any {
    const lastResult = context.getLastResult();
    const errors = context.getErrors();

    return {
      summary: `Response for ${intent.category} request.`,
      status: errors.length === 0 ? 'success' : 'partial_success',
      data: lastResult?.output,
            history: context.getFullHistory().map((h: any) => ({ tool: h.tool, status: h.status })),

      errors: errors.length > 0 ? errors : undefined,
      // Guidance field will be enhanced in Phase 3
      guidance: {
        message: 'Analysis complete. Ready for next steps.',
        suggestedActions: []
      }
    };
  }

}
