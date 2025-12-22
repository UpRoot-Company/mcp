
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class ChangePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent, action } = intent;
    const { dryRun = true, includeImpact = true } = constraints;

    let targetPath = targets[0];
    const rawEdits = Array.isArray(constraints.edits) ? constraints.edits : [];

    // 1. 타겟 파일이 명시되지 않은 경우 검색 시도
    if (!targetPath) {
      const search = await this.registry.execute('search_project', { query: originalIntent, maxResults: 1 });
      if (search.results && search.results.length > 0) {
        targetPath = search.results[0].path;
      }
    }


        if (!targetPath) {
      return { success: false, message: 'Could not identify the target to modify.' };
    }

    const edits = rawEdits.map((edit: any) => ({
      ...edit,
      filePath: edit.filePath || targetPath
    }));

    // 2. Impact Analysis (Parallel)
    const impactPromise = includeImpact
      ? this.runTool(context, 'impact_analyzer', { target: targetPath, edits })
      : Promise.resolve(null);
    const dependencyPromise = includeImpact
      ? this.runTool(context, 'analyze_relationship', { target: targetPath, mode: 'dependencies', direction: 'both' })
      : Promise.resolve(null);
    const hotSpotPromise = includeImpact
      ? this.runTool(context, 'hotspot_detector', {})
      : Promise.resolve([]);

    // 3. Execute Edit (Includes DryRun)
    const editResult = await this.runTool(context, 'edit_coordinator', {
      filePath: targetPath,
      edits,
      dryRun
    });

    let finalResult = editResult;
    let autoCorrected = false;

    if (!editResult.success && edits.length > 0) {
      const attempts = [
        { label: 'whitespace', edits: edits.map((edit: any) => ({ ...edit, fuzzyMode: edit.fuzzyMode ?? 'whitespace' })) },
        { label: 'structural', edits: edits.map((edit: any) => ({ ...edit, normalization: edit.normalization ?? 'structural' })) },
        { label: 'fuzzy', edits: edits.map((edit: any) => ({ ...edit, fuzzyMode: edit.fuzzyMode ?? 'levenshtein' })) }
      ];
      for (const attempt of attempts) {
        const correctedResult = await this.runTool(context, 'edit_coordinator', {
          filePath: targetPath,
          edits: attempt.edits,
          dryRun
        });
        if (correctedResult.success) {
          finalResult = correctedResult;
          autoCorrected = true;
          break;
        }
      }
    }

    const impact = dryRun ? (finalResult.impactPreview ?? null) : await impactPromise;
    const deps = await dependencyPromise;
    const hotSpots = await hotSpotPromise;
    const impactReport = this.toImpactReport(impact, deps, targetPath, hotSpots);
    const plan = dryRun
      ? {
          steps: [
            {
              action: 'modify' as const,
              file: targetPath,
              description: intent.originalIntent,
              diff: finalResult.diff
            }
          ]
        }
      : undefined;

    return {
      success: finalResult.success,
      operation: dryRun ? 'plan' : 'apply',
      targetFile: targetPath,
      diff: finalResult.diff,
      plan,
      impactReport,
      editResult: dryRun ? undefined : finalResult,
      transactionId: finalResult.operation?.id ?? '',
      rollbackAvailable: !dryRun && Boolean(finalResult.success),
      autoCorrected,
      guidance: {
        message: dryRun ? 'Change plan generated. Review the diff before applying.' : 'Changes successfully applied.',
        suggestedActions: dryRun ?
          [{ pillar: 'change', action: 'apply', intent: originalIntent, options: { dryRun: false, edits } }] :
          [{ pillar: 'manage', action: 'test' }]
      }
    };


  }

  private toImpactReport(impact: any, deps: any, targetPath: string, hotSpots: any) {
    if (!impact) return undefined;
    const suggestedTests = Array.isArray(impact.suggestedTests) ? impact.suggestedTests : [];
    const testPriority = new Map(suggestedTests.map((t: string) => [t, 'important' as const]));
    const impacted = Array.isArray(impact?.summary?.impactedFiles) ? impact.summary.impactedFiles : [];
    const pageRankDelta = this.computePageRankDelta(deps, [targetPath, ...impacted]);
    const impactedSet = new Set([targetPath, ...impacted].filter(Boolean));
    const affectedHotSpots = Array.isArray(hotSpots)
      ? hotSpots.filter((spot: any) => impactedSet.has(spot?.filePath))
      : [];
    return {
      preview: impact,
      affectedHotSpots,
      pageRankDelta,
      breakingChangeRisk: impact.riskLevel ?? 'low',
      suggestedTests,
      testPriority
    };
  }

  private computePageRankDelta(deps: any, impactedFiles: string[]): Map<string, number> {
    const edges = Array.isArray(deps?.edges) ? deps.edges : [];
    if (edges.length === 0 || impactedFiles.length === 0) return new Map();
    const baseline = this.computePageRankFromEdges(edges);
    const impactedSet = new Set(impactedFiles.filter(Boolean));
    const filtered = edges.filter((edge: any) => impactedSet.has(edge.source ?? edge.from) && impactedSet.has(edge.target ?? edge.to));
    const scoped = this.computePageRankFromEdges(filtered);
    const delta = new Map<string, number>();
    for (const file of impactedSet) {
      const base = baseline.get(file) ?? 0;
      const next = scoped.get(file) ?? 0;
      delta.set(file, Number((next - base).toFixed(6)));
    }
    return delta;
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

  private async runTool(context: OrchestrationContext, tool: string, args: any) {
    const started = Date.now();
    const output = await this.registry.execute(tool, args);
    context.addStep({
      id: `${tool}_${context.getFullHistory().length + 1}`,
      tool,
      args,
      output,
      status: output?.success === false || output?.isError ? 'failure' : 'success',
      duration: Date.now() - started
    });
    return output;
  }
}
