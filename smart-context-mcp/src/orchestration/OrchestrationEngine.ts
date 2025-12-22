
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
import { AutoCorrectionStrategy } from './AutoCorrectionStrategy.js';
import { EagerLoadingStrategy } from './EagerLoadingStrategy.js';
import { CachingStrategy } from './CachingStrategy.js';


export class OrchestrationEngine {
  private pillars: Map<string, any> = new Map();
  private synthesizer = new InsightSynthesizer();
  private guidanceGenerator = new GuidanceGenerator();
  private autoCorrection = new AutoCorrectionStrategy();
  private eagerLoading = new EagerLoadingStrategy();

  constructor(
    private readonly intentRouter: IntentRouter,
    private readonly planner: WorkflowPlanner,
    private readonly registry: InternalToolRegistry,
    private readonly cacheStrategy: CachingStrategy = new CachingStrategy()
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
    if (typeof args !== 'string' && this.isCacheable(category, args)) {
      return this.cacheStrategy.getCachedOrExecute(
        category,
        args,
        () => this.executePillarInternal(category, args),
        {
          shouldCache: (value) => value?.success !== false && value?.status !== 'partial_success'
        }
      );
    }
    return this.executePillarInternal(category, args);
  }

  private async executePillarInternal(category: string, args: any): Promise<any> {
    const context = new OrchestrationContext();
    const intent = typeof args === 'string'
      ? this.intentRouter.parse(args)
      : this.mapArgsToIntent(category, args);

    if (typeof args === 'string') {
      const workflowKey = this.cacheStrategy.getCacheKey('workflow', intent);
      const cachedPlan = this.cacheStrategy.getCachedWorkflow<any>(workflowKey);
      const plan = cachedPlan ?? this.planner.plan(intent);
      if (!cachedPlan) {
        this.cacheStrategy.cacheWorkflow(workflowKey, plan);
      }
      if (plan.steps.length > 0) {
        await this.executePlan(plan, context);
        if (context.getErrors().length > 0) {
          const corrected = await this.autoCorrection.attempt(intent, context, this.registry);
          if (corrected) {
            context.clearErrors();
          }
        }
        if (context.getErrors().length === 0) {
          await this.eagerLoading.execute(intent, context, this.registry);
        }
        return this.synthesizeResponse(intent, context);
      }
    }

    const pillar = this.pillars.get(category);
    if (!pillar) {
      throw new Error(`Pillar not found: ${category}`);
    }

    const result = await pillar.execute(intent, context);

    const impactPreviews = result.impactReport ? [result.impactReport] : [];
    const insights = this.synthesizer.synthesize({
      skeletons: result.structure ? [{ content: result.structure }] : (result.profile ? [{ ...result.profile.structure, symbols: result.profile.structure?.symbols }] : []),
      calls: result.relationships?.calls,
      dependencies: result.relationships?.dependencies,
      hotSpots: result.impactReport?.hotSpots || [],
      impactPreviews
    });

    const pageRankCoverage = insights.pageRankSummary?.coverage ?? 0;
    const generatedGuidance = this.guidanceGenerator.generate({
      lastPillar: category,
      lastResult: result,
      insights: insights.insights,
      synthesis: {
        hotSpots: result.impactReport?.hotSpots ?? [],
        impactIncluded: impactPreviews.length > 0,
        pageRankCoverage
      }
    });
    const guidance = result?.guidance
      ? {
          ...generatedGuidance,
          ...result.guidance,
          suggestedActions: result.guidance?.suggestedActions?.length
            ? result.guidance.suggestedActions
            : generatedGuidance.suggestedActions
        }
      : generatedGuidance;

    const response: any = {
      ...result,
      insights: insights.insights,
      visualization: insights.visualization,
      guidance,
      internalToolsUsed: context.getFullHistory().map((h: any) => h.tool)
    };
    if (intent.category === 'understand') {
      const edges = result?.relationships?.dependencies?.edges ?? [];
      const includePageRank = intent.constraints.include?.pageRank === true;
      const includeDependencies = intent.constraints.include?.dependencies === true || includePageRank;
      if (includePageRank) {
        const pageRankScores = this.computePageRankFromEdges(edges);
        response.pageRankScores = pageRankScores;
        if (result?.report?.complexity) {
          response.report = {
            ...result.report,
            architecturalRole: this.classifyRole(pageRankScores.get(result.primaryFile ?? '') ?? 0, result.report.complexity)
          };
        }
      }
      if (includeDependencies) {
        response.impactRadius = Array.isArray(edges) ? edges.length : 0;
      }
      if (result?.report?.complexity && !includePageRank) {
        response.report = {
          ...result.report,
          architecturalRole: result.report.architecturalRole ?? 'utility'
        };
      }
    }
    return response;
  }

  private computePageRankFromEdges(edges: Array<{ source?: string; target?: string; from?: string; to?: string }>): Map<string, number> {
    const normalized = edges
      .map(edge => ({ from: edge.from ?? edge.source, to: edge.to ?? edge.target }))
      .filter(edge => edge.from && edge.to) as Array<{ from: string; to: string }>;
    if (normalized.length === 0) return new Map();

    const nodes = new Set<string>();
    for (const edge of normalized) {
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
    const ids = Array.from(nodes);
    const n = ids.length;
    if (n === 0) return new Map();

    const outgoing = new Map<string, string[]>();
    for (const id of ids) outgoing.set(id, []);
    for (const edge of normalized) {
      outgoing.get(edge.from)!.push(edge.to);
    }

    const damping = 0.85;
    let ranks = new Map<string, number>(ids.map(id => [id, 1 / n]));
    for (let iter = 0; iter < 12; iter++) {
      const next = new Map<string, number>(ids.map(id => [id, (1 - damping) / n]));
      for (const id of ids) {
        const outs = outgoing.get(id) ?? [];
        const share = (ranks.get(id) ?? 0) / (outs.length || n);
        if (outs.length === 0) {
          for (const other of ids) {
            next.set(other, (next.get(other) ?? 0) + damping * share);
          }
        } else {
          for (const to of outs) {
            next.set(to, (next.get(to) ?? 0) + damping * share);
          }
        }
      }
      ranks = next;
    }

    return ranks;
  }

  private classifyRole(score: number, complexity: { fanIn: number; fanOut: number }): 'core' | 'utility' | 'integration' | 'peripheral' {
    if (score >= 0.15 || (complexity.fanIn + complexity.fanOut) >= 15) return 'core';
    if (complexity.fanIn >= 5 && complexity.fanOut >= 5) return 'integration';
    if (complexity.fanOut > complexity.fanIn) return 'utility';
    return 'peripheral';
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
          const failed = output?.success === false || output?.isError === true;
          context.addStep({
            id: step.id,
            tool: step.tool,
            args: params,
            output,
            status: failed ? 'failure' : 'success',
            duration: Date.now() - started
          });
          if (failed) {
            context.addError({
              code: output?.errorCode ?? output?.code ?? 'STEP_FAILED',
              message: output?.message ?? 'Step execution failed',
              tool: step.tool,
              target: params?.filePath ?? params?.target
            });
          }
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
    let targets = args.target
      ? [args.target]
      : (args.targetFiles || (args.targetPath ? [args.targetPath] : []));
    if ((!targets || targets.length === 0) && typeof args?.goal === 'string') {
      targets = [args.goal];
    }

    return {
      category: category as any,
      action: args.action || args.command || 'execute',
      targets,
      originalIntent: JSON.stringify(args),
      constraints: {
        ...(args.options || {}),
        goal: args.goal,
        depth: args.depth,
        scope: args.scope,
        limit: args.limit,
        include: args.include,
        edits: args.edits,
        view: args.view,
        lineRange: args.lineRange,
        includeProfile: args.includeProfile,
        includeHash: args.includeHash,
        context: args.context,
        targetPath: args.targetPath,
        content: args.content,
        template: args.template
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

    const data = this.collectSynthesisData(context);
    const insights = this.synthesizer.synthesize(data);
    const pageRankCoverage = insights.pageRankSummary?.coverage ?? (data.pageRank ? data.pageRank.size : 0);
    const guidance = this.guidanceGenerator.generate({
      lastPillar: intent.category,
      lastResult: lastResult?.output ?? {},
      insights: insights.insights,
      error: errors[0],
      history: context.getFullHistory(),
      synthesis: {
        hotSpots: data.hotSpots,
        pageRankCoverage,
        impactIncluded: data.impactPreviews.length > 0
      }
    });

    return {
      summary: `Response for ${intent.category} request.`,
      status: errors.length === 0 ? 'success' : 'partial_success',
      data: lastResult?.output,
      history: context.getFullHistory().map((h: any) => ({ tool: h.tool, status: h.status })),
      insights: insights.insights,
      visualization: insights.visualization,
      internalToolsUsed: context.getFullHistory().map((h: any) => h.tool),
      errors: errors.length > 0 ? errors : undefined,
      guidance
    };
  }

  private collectSynthesisData(context: OrchestrationContext): {
    skeletons: any[];
    calls: any;
    dependencies: any;
    hotSpots: any[];
    pageRank?: Map<string, number>;
    impactPreviews: any[];
  } {
    const skeletons: any[] = [];
    let calls: any = undefined;
    let dependencies: any = undefined;
    let hotSpots: any[] = [];
    const impactPreviews: any[] = [];

    for (const step of context.getFullHistory()) {
      if (step.tool === 'read_code' && typeof step.output === 'string') {
        skeletons.push({ content: step.output });
      }
      if (step.tool === 'file_profiler' && step.output?.structure) {
        skeletons.push({ ...step.output.structure, symbols: step.output.structure?.symbols });
      }
      if (step.tool === 'analyze_relationship') {
        if (!calls && step.args?.mode === 'calls') calls = step.output;
        if (!dependencies && step.args?.mode === 'dependencies') dependencies = step.output;
      }
      if (step.tool === 'hotspot_detector' && Array.isArray(step.output)) {
        hotSpots = step.output;
      }
      if (step.tool === 'impact_analyzer' && step.output) {
        impactPreviews.push(step.output);
      }
      if (step.tool === 'edit_coordinator') {
        if (step.output?.impactPreview) impactPreviews.push(step.output.impactPreview);
        if (Array.isArray(step.output?.impactPreviews)) impactPreviews.push(...step.output.impactPreviews);
      }
    }

    return { skeletons, calls, dependencies, hotSpots, impactPreviews };
  }

  private isCacheable(category: string, args: any): boolean {
    if (!args || typeof args !== 'object') return false;
    if (category === 'change' || category === 'write' || category === 'manage') return false;
    return category === 'read' || category === 'navigate' || category === 'understand';
  }

}
