
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';
import { ChangeBudgetManager } from '../ChangeBudgetManager.js';
import { analyzeQuery } from '../../engine/search/QueryMetrics.js';


export class ChangePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent, action } = intent;
    const { dryRun = true, includeImpact = false } = constraints;

    const rawEdits = Array.isArray(constraints.edits) ? constraints.edits : [];
    let targetPath: string | undefined = constraints.targetPath || targets[0] || this.extractTargetFromEdits(rawEdits);

    // 1. 타겟 파일이 명시되지 않은 경우 검색 시도
    let candidates: Array<{ path: string; score?: number; reason: string }> = [];
    if (!targetPath) {
      const resolved = await this.resolveTargetPath(originalIntent, context);
      targetPath = resolved.targetPath;
      candidates = resolved.candidates;
    }

    if (!targetPath) {
      return {
        success: false,
        message: 'Could not identify the target to modify.',
        candidates,
        guidance: {
          message: 'Provide a target file path or select a file via navigate/search.',
          suggestedActions: [
            { pillar: 'navigate', action: 'find', target: originalIntent },
            { pillar: 'change', action: 'retry', intent: originalIntent, target: '<filePath>' }
          ]
        }
      };
    }

    const normalization = this.normalizeEdits(rawEdits, targetPath);
    const edits = normalization.edits;
    if (edits.length === 0) {
      return {
        success: false,
        message: 'No valid edits provided. Ensure targetContent/targetString and replacement/template are set.',
        invalidEdits: normalization.invalidEdits,
        guidance: {
          message: 'Use read to copy exact text or provide a shorter targetString.',
          suggestedActions: [
            { pillar: 'read', action: 'view_fragment', target: targetPath },
            { pillar: 'change', action: 'retry', intent: originalIntent, target: targetPath }
          ]
        }
      };
    }

    const budget = ChangeBudgetManager.create({
      intentText: originalIntent,
      targetSample: edits[0]?.targetString,
      includeImpact,
      dryRun
    });
    const allowImpactPreview = includeImpact === true;

    // 2. Impact Analysis (Parallel, opt-in)
    const impactPromise = !dryRun && budget.allowImpact
      ? this.runTool(context, 'impact_analyzer', { target: targetPath, edits })
      : Promise.resolve(null);
    const dependencyPromise = !dryRun && budget.allowImpact
      ? this.runTool(context, 'analyze_relationship', { target: targetPath, mode: 'dependencies', direction: 'both' })
      : Promise.resolve(null);
    const hotSpotPromise = !dryRun && budget.allowImpact
      ? this.runTool(context, 'hotspot_detector', {})
      : Promise.resolve([]);

    // 3. Execute Edit (Includes DryRun)
    const editResult = await this.runTool(context, 'edit_coordinator', {
      filePath: targetPath,
      edits,
      dryRun,
      options: {
        skipImpactPreview: dryRun && !allowImpactPreview
      }
    });

    let finalResult = editResult;
    let autoCorrected = false;
    const autoCorrectionAttempts: string[] = [];

    if (!editResult.success && edits.length > 0) {
      const attempts: Array<{ label: string; edits: any[] }> = [];
      if (budget.allowNormalization) {
        attempts.push({ label: 'whitespace', edits: edits.map((edit: any) => ({ ...edit, fuzzyMode: edit.fuzzyMode ?? 'whitespace' })) });
        attempts.push({ label: 'structural', edits: edits.map((edit: any) => ({ ...edit, normalization: edit.normalization ?? 'structural' })) });
      }
      if (budget.allowLevenshtein) {
        const eligible = edits.every((edit: any) => (edit?.targetString?.length ?? 0) <= budget.maxLevenshteinTargetLength);
        if (eligible) {
          attempts.push({ label: 'fuzzy', edits: edits.map((edit: any) => ({ ...edit, fuzzyMode: edit.fuzzyMode ?? 'levenshtein' })) });
        }
      }
      const maxAttempts = Math.max(0, budget.maxMatchAttempts - 1);
      const limitedAttempts = attempts.slice(0, maxAttempts);
      autoCorrectionAttempts.push(...limitedAttempts.map(attempt => attempt.label));
      for (const attempt of limitedAttempts) {
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

    const impact = dryRun ? (allowImpactPreview ? (finalResult.impactPreview ?? null) : null) : await impactPromise;
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

    const failureGuidance = !finalResult.success
      ? this.buildFailureGuidance({
          intent: originalIntent,
          targetPath,
          edits,
          dryRun,
          failureMessage: finalResult.message ?? finalResult.details?.message,
          autoCorrectionAttempts
        })
      : undefined;

    const successGuidance = {
      message: dryRun ? 'Change plan generated. Review the diff before applying.' : 'Changes successfully applied.',
      suggestedActions: dryRun ?
        [{
          pillar: 'change',
          action: 'apply',
          intent: originalIntent,
          target: targetPath,
          edits,
          options: { dryRun: false }
        }] :
        [{ pillar: 'manage', action: 'test' }]
    };

    const truncatedDiff = (typeof finalResult.diff === 'string' && finalResult.diff.length > budget.maxDiffBytes)
      ? `${finalResult.diff.slice(0, budget.maxDiffBytes)}\n... (diff truncated)`
      : finalResult.diff;

    const refinementStage = autoCorrectionAttempts.includes('fuzzy')
      ? 'fuzzy'
      : (autoCorrectionAttempts.length > 0 ? 'normalized' : 'exact');

    return {
      success: finalResult.success,
      message: finalResult.success ? undefined : (finalResult.message ?? finalResult.details?.message),
      operation: dryRun ? 'plan' : 'apply',
      targetFile: targetPath,
      diff: truncatedDiff,
      plan,
      impactReport,
      editResult: dryRun ? undefined : finalResult,
      transactionId: finalResult.operation?.id ?? '',
      rollbackAvailable: !dryRun && Boolean(finalResult.success),
      autoCorrected,
      autoCorrectionAttempts: autoCorrectionAttempts.length > 0 ? autoCorrectionAttempts : undefined,
      guidance: failureGuidance ?? successGuidance,
      degraded: !finalResult.success && autoCorrectionAttempts.length === 0,
      refinement: {
        stage: refinementStage,
        reason: autoCorrected ? 'low_confidence' : undefined
      },
      budget: {
        ...budget,
        used: {
          attempts: 1 + autoCorrectionAttempts.length
        }
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

  private extractPath(text: string): string | null {
    if (!text) return null;
    const match = text.match(/([\\w./-]+\\.(ts|tsx|js|jsx|json|md))/i);
    if (match) return match[1];
    if (/[\\/]/.test(text) && /\\.[a-z0-9]+$/i.test(text.trim())) {
      return text.trim();
    }
    return null;
  }

  private async resolveTargetPath(
    intentText: string,
    context: OrchestrationContext
  ): Promise<{ targetPath?: string; candidates: Array<{ path: string; score?: number; reason: string }> }> {
    const candidates: Array<{ path: string; score?: number; reason: string }> = [];
    const explicit = this.extractPath(intentText);
    if (explicit) {
      return { targetPath: explicit, candidates: [{ path: explicit, reason: 'explicit_path' }] };
    }

    const metrics = analyzeQuery(intentText);

    const filenameSearch = await this.runTool(context, 'search_project', {
      query: intentText,
      type: 'filename',
      maxResults: 3
    });
    this.collectCandidates(candidates, filenameSearch?.results ?? [], 'filename_search');

    const symbolSearch = await this.runTool(context, 'search_project', {
      query: intentText,
      type: 'symbol',
      maxResults: 3
    });
    this.collectCandidates(candidates, symbolSearch?.results ?? [], 'symbol_search');

    if (metrics.strong) {
      const fileSearch = await this.runTool(context, 'search_project', {
        query: intentText,
        type: 'file',
        maxResults: 3
      });
      this.collectCandidates(candidates, fileSearch?.results ?? [], 'file_search');
    }

    const sorted = this.sortCandidates(candidates);
    const targetPath = sorted[0]?.path;
    return { targetPath, candidates: sorted };
  }

  private extractTargetFromEdits(edits: any[]): string | undefined {
    for (const edit of edits) {
      const candidate = edit?.filePath ?? edit?.path;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
      const targetCandidate = edit?.target;
      if (this.isLikelyFilePath(targetCandidate)) {
        return targetCandidate.trim();
      }
    }
    return undefined;
  }

  private normalizeEdits(
    rawEdits: any[],
    targetPath: string
  ): { edits: any[]; invalidEdits: any[] } {
    const edits: any[] = [];
    const invalidEdits: any[] = [];

    for (const edit of rawEdits) {
      const operation = this.normalizeOperation(edit?.operation ?? edit?.op);
      const filePath = typeof edit?.filePath === 'string' && edit.filePath.trim().length > 0
        ? edit.filePath
        : (typeof edit?.path === 'string' && edit.path.trim().length > 0
          ? edit.path
          : (this.isLikelyFilePath(edit?.target) ? edit.target : targetPath));
      const targetFallback = typeof edit?.target === 'string' && !this.isLikelyFilePath(edit.target)
        ? edit.target
        : '';
      const targetString = edit?.targetString
        ?? edit?.targetContent
        ?? edit?.from
        ?? edit?.search
        ?? edit?.anchor
        ?? edit?.anchorString
        ?? targetFallback
        ?? '';
      let replacementString = edit?.replacementString
        ?? edit?.replacement
        ?? edit?.replace
        ?? edit?.template
        ?? edit?.to
        ?? edit?.with
        ?? edit?.content
        ?? edit?.text
        ?? '';
      const insertOverrides = this.inferInsertConfig(operation, edit, targetString, replacementString);
      if (insertOverrides.replacementString !== undefined) {
        replacementString = insertOverrides.replacementString;
      }

      if (operation === 'delete') {
        replacementString = '';
      }

      const insertMode = insertOverrides.insertMode ?? edit?.insertMode;
      const insertLineRange = insertOverrides.insertLineRange ?? edit?.insertLineRange;

      const normalized = {
        filePath,
        targetString: typeof targetString === 'string' ? targetString : '',
        replacementString: typeof replacementString === 'string' ? replacementString : '',
        lineRange: edit?.lineRange,
        indexRange: edit?.indexRange,
        beforeContext: edit?.beforeContext ?? edit?.contextBefore,
        afterContext: edit?.afterContext ?? edit?.contextAfter,
        fuzzyMode: edit?.fuzzyMode,
        normalization: edit?.normalization,
        normalizationConfig: edit?.normalizationConfig,
        expectedHash: edit?.expectedHash,
        contextFuzziness: edit?.contextFuzziness,
        insertMode,
        insertLineRange,
        anchorSearchRange: edit?.anchorSearchRange,
        escapeMode: edit?.escapeMode
      };

      const requiresAnchor = normalized.insertMode === 'before' || normalized.insertMode === 'after';
      const missingInsertLine = normalized.insertMode === 'at' && !normalized.insertLineRange?.start;
      if ((!normalized.targetString && !normalized.insertMode) || (requiresAnchor && !normalized.targetString) || missingInsertLine) {
        invalidEdits.push(edit);
        continue;
      }

      edits.push(normalized);
    }

    return { edits, invalidEdits };
  }

  private isLikelyFilePath(value: any): value is string {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.includes('\n')) return false;
    if (/\s/.test(trimmed)) return false;
    if (/[\\/]/.test(trimmed)) return true;
    return /\.[a-z0-9]+$/i.test(trimmed);
  }

  private collectCandidates(
    candidates: Array<{ path: string; score?: number; reason: string }>,
    results: any[],
    reason: string
  ): void {
    for (const result of results) {
      const pathValue = result?.path;
      if (!pathValue) continue;
      if (candidates.find(candidate => candidate.path === pathValue)) continue;
      candidates.push({ path: pathValue, score: result?.score, reason });
      if (candidates.length >= 5) break;
    }
  }

  private normalizeOperation(raw: any): string {
    const value = String(raw ?? 'replace').trim().toLowerCase();
    if (value === 'remove') return 'delete';
    if (value === 'add') return 'insert';
    if (value === 'append') return 'insert';
    if (value === 'prepend') return 'insert';
    return value;
  }

  private inferInsertConfig(
    operation: string,
    edit: any,
    targetString: any,
    replacementString: any
  ): { insertMode?: 'before' | 'after' | 'at'; insertLineRange?: { start: number }; replacementString?: string } {
    const normalizedTarget = typeof targetString === 'string' ? targetString : '';
    const position = String(edit?.position ?? edit?.insertPosition ?? edit?.anchorPosition ?? '').toLowerCase();
    let insertMode: 'before' | 'after' | 'at' | undefined = undefined;

    if (edit?.insertMode) {
      insertMode = edit.insertMode;
    } else if (position === 'before' || position === 'after' || position === 'at') {
      insertMode = position as any;
    } else if (position === 'append') {
      insertMode = 'after';
    } else if (position === 'prepend') {
      insertMode = 'before';
    }

    if (!insertMode && (operation === 'insert' || operation === 'append' || operation === 'prepend')) {
      if (operation === 'prepend') {
        insertMode = 'before';
      } else if (operation === 'append') {
        insertMode = 'after';
      } else if (edit?.insertLineRange?.start || edit?.lineRange?.start) {
        insertMode = 'at';
      } else if (normalizedTarget) {
        insertMode = 'after';
      }
    }

    const insertLineRange = edit?.insertLineRange ?? (edit?.lineRange?.start ? { start: edit.lineRange.start } : undefined);

    if (!insertMode) {
      return {};
    }

    let resolvedReplacement = replacementString;
    if (!resolvedReplacement && typeof edit?.insertContent === 'string') {
      resolvedReplacement = edit.insertContent;
    }

    return {
      insertMode,
      insertLineRange,
      replacementString: typeof resolvedReplacement === 'string' ? resolvedReplacement : replacementString
    };
  }

  private buildFailureGuidance(args: {
    intent: string;
    targetPath: string;
    edits: any[];
    dryRun: boolean;
    failureMessage?: string;
    autoCorrectionAttempts: string[];
  }): { message: string; suggestedActions: any[] } {
    const lineRange = this.suggestLineRange(args.edits);
    const actions: any[] = [
      {
        pillar: 'read',
        action: 'view_fragment',
        target: args.targetPath,
        options: lineRange ? { view: 'fragment', lineRange } : { view: 'fragment' }
      },
      {
        pillar: 'change',
        action: 'retry',
        intent: args.intent,
        target: args.targetPath
      },
      {
        pillar: 'write',
        action: 'overwrite',
        intent: `Rewrite ${args.targetPath} with updated content`,
        targetPath: args.targetPath
      }
    ];

    const messages: string[] = [];
    if (args.failureMessage) {
      messages.push(args.failureMessage);
    } else {
      messages.push('Change failed. Provide a more precise targetString or smaller edit scope.');
    }
    if (args.autoCorrectionAttempts.length > 0) {
      messages.push(`Auto-corrections attempted: ${args.autoCorrectionAttempts.join(', ')}.`);
    }

    return {
      message: messages.join(' '),
      suggestedActions: actions
    };
  }

  private suggestLineRange(edits: any[]): string | undefined {
    for (const edit of edits) {
      if (edit?.lineRange?.start) {
        const start = edit.lineRange.start;
        const end = edit.lineRange.end ?? start;
        return `${start}-${end}`;
      }
      if (edit?.insertLineRange?.start) {
        const start = edit.insertLineRange.start;
        const end = Math.max(start, start + 4);
        return `${Math.max(1, start - 4)}-${end}`;
      }
    }
    return undefined;
  }

  private sortCandidates(
    candidates: Array<{ path: string; score?: number; reason: string }>
  ): Array<{ path: string; score?: number; reason: string; confidence?: number }> {
    const reasonWeights: Record<string, number> = {
      file_search: 1.0,
      filename_search: 0.8,
      symbol_search: 0.4,
      explicit_path: 1.2
    };

    const scored = candidates.map((candidate, index) => {
      const score = typeof candidate.score === 'number' ? candidate.score : 0;
      const weight = reasonWeights[candidate.reason] ?? 0.3;
      const confidence = score + weight;
      return { ...candidate, confidence, _index: index };
    });

    scored.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
      return a._index - b._index;
    });

    return scored.map(({ _index, ...candidate }) => candidate);
  }
}
