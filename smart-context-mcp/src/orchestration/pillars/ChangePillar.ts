
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';
import { ChangeBudgetManager } from '../ChangeBudgetManager.js';
import { analyzeQuery } from '../../engine/search/QueryMetrics.js';
import * as path from 'path';
import { IntegrityEngine } from '../../integrity/IntegrityEngine.js';
import type { IntegrityFinding, IntegrityReport } from '../../integrity/IntegrityTypes.js';
import { metrics } from '../../utils/MetricsCollector.js';
import { ConfigurationManager } from '../../config/ConfigurationManager.js';
import { EditResolver } from '../../engine/EditResolver.js';
import type { ResolveError } from '../../types.js';
import { EditCoordinator } from '../../engine/EditCoordinator.js';
import { EditorEngine } from '../../engine/Editor.js';
import { HistoryEngine } from '../../engine/History.js';
import { NodeFileSystem } from '../../platform/FileSystem.js';


export class ChangePillar {
  private fileSystem = new NodeFileSystem(process.cwd());
  
  constructor(private readonly registry: InternalToolRegistry) {}

  private getEditCoordinator(): EditCoordinator {
    // Create EditCoordinator instance when needed
    // EditorEngine and HistoryEngine need rootPath and fileSystem
    const rootPath = process.cwd();
    const editorEngine = new EditorEngine(rootPath, this.fileSystem);
    const historyEngine = new HistoryEngine(rootPath, this.fileSystem);
    return new EditCoordinator(editorEngine, historyEngine);
  }

  private getEditResolver(): EditResolver {
    // Create EditResolver instance when needed
    const rootPath = process.cwd();
    const editorEngine = new EditorEngine(rootPath, this.fileSystem);
    return new EditResolver(this.fileSystem, editorEngine);
  }

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const stopTotal = metrics.startTimer("change.total_ms");
    try {
    const { targets, constraints, originalIntent, action } = intent;
    const { dryRun = true, includeImpact = false } = constraints;
      const integrityOptions = IntegrityEngine.resolveOptions(constraints.integrity, "change");

      const rawEdits = Array.isArray(constraints.edits) ? constraints.edits : [];
      const targetFiles = this.resolveTargetFiles(constraints, targets);
      const editPaths = this.collectEditPaths(rawEdits);
      const shouldBatch = this.shouldUseBatch(constraints, targetFiles, editPaths);
    
    // ADR-042-005: Phase B2 - Check for v2 editor mode
    const v2Enabled = ConfigurationManager.getEditorV2Enabled();
    const v2Mode = ConfigurationManager.getEditorV2Mode();
    const useV2 = v2Enabled && v2Mode !== 'off';
    
    if (useV2 && shouldBatch) {
      return this.executeV2BatchChange({
        intent,
        context,
        rawEdits,
        targetFiles,
        dryRun,
        includeImpact,
        v2Mode
      });
    }
    
    if (shouldBatch) {
      return this.executeBatchChange({
        intent,
        context,
        rawEdits,
        targetFiles,
        dryRun,
        includeImpact
      });
    }

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
      dryRun,
      editCount: edits.length,
      batchMode: Boolean(constraints?.batchMode)
    });
    const allowImpactPreview = includeImpact === true;

    let integrityReport: IntegrityReport | undefined;
    if (integrityOptions && integrityOptions.mode !== "off") {
      integrityReport = (await IntegrityEngine.run(
        {
          query: originalIntent,
          targetPaths: targetPath ? [targetPath] : undefined,
          scope: integrityOptions.scope ?? "auto",
          sources: integrityOptions.sources ?? [],
          limits: integrityOptions.limits ?? {},
          mode: integrityOptions.mode ?? "preflight"
        },
        (tool, args) => this.runTool(context, tool, args)
      )).report;

      if (!dryRun && shouldBlockIntegrity(integrityOptions.mode ?? "preflight", integrityOptions.blockPolicy, integrityReport)) {
        const blockedReport: IntegrityReport = {
          ...integrityReport,
          status: "blocked",
          blockedReason: integrityReport.blockedReason ?? "high_severity_conflict"
        };
        const blockedSummary = this.formatIntegrityBlockMessage(blockedReport.topFindings);
        return {
          success: false,
          status: "blocked",
          message: blockedSummary,
          operation: "apply",
          targetFile: targetPath,
          integrity: blockedReport,
          guidance: {
            message: blockedSummary
          }
        };
      }
    }

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
      const stopEdit = metrics.startTimer("change.edit_coordinator_ms");
      let editResult: any;
      try {
        editResult = await this.runTool(context, 'edit_coordinator', {
          filePath: targetPath,
          edits,
          dryRun,
          options: {
            skipImpactPreview: dryRun && !allowImpactPreview
          }
        });
      } finally {
        stopEdit();
      }

    let finalResult = editResult;
    let autoCorrected = false;
    const autoCorrectionAttempts: string[] = [];

    let allowLevenshtein = budget.allowLevenshtein;
    if (allowLevenshtein) {
      const minTargetLength = this.getMinLevenshteinTargetLength();
      const tooShort = edits.some((edit: any) => (edit?.targetString?.length ?? 0) < minTargetLength);
      if (tooShort) {
        allowLevenshtein = false;
      } else {
        const maxFileBytes = this.getMaxLevenshteinFileBytes();
        if (maxFileBytes > 0) {
          try {
            const stat = await this.runTool(context, 'stat_file', { path: targetPath });
            if (typeof stat?.size === 'number' && stat.size > maxFileBytes) {
              allowLevenshtein = false;
            }
          } catch {
            // ignore stat failures
          }
        }
      }
    }

    if (!editResult.success && edits.length > 0) {
      const attempts: Array<{ label: string; edits: any[] }> = [];
      if (budget.allowNormalization) {
        attempts.push({ label: 'whitespace', edits: edits.map((edit: any) => ({ ...edit, fuzzyMode: edit.fuzzyMode ?? 'whitespace' })) });
        attempts.push({ label: 'structural', edits: edits.map((edit: any) => ({ ...edit, normalization: edit.normalization ?? 'structural' })) });
      }
      if (allowLevenshtein) {
        const eligible = edits.every((edit: any) => (edit?.targetString?.length ?? 0) <= budget.maxLevenshteinTargetLength);
        if (eligible) {
          attempts.push({ label: 'fuzzy', edits: edits.map((edit: any) => ({ ...edit, fuzzyMode: edit.fuzzyMode ?? 'levenshtein' })) });
        }
      }
      const maxAttempts = Math.max(0, budget.maxMatchAttempts - 1);
      const limitedAttempts = attempts.slice(0, maxAttempts);
      autoCorrectionAttempts.push(...limitedAttempts.map(attempt => attempt.label));
      for (const attempt of limitedAttempts) {
        const stopCorrect = metrics.startTimer("change.edit_coordinator_ms");
        let correctedResult: any;
        try {
          correctedResult = await this.runTool(context, 'edit_coordinator', {
            filePath: targetPath,
            edits: attempt.edits,
            dryRun
          });
        } finally {
          stopCorrect();
        }
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

    const successGuidance: any = {
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

      let relatedDocs: Array<any> | undefined;
      if (!dryRun && finalResult.success && this.shouldSuggestDocs(constraints)) {
        const stopDocs = metrics.startTimer("change.doc_suggest_ms");
        try {
          relatedDocs = await this.suggestDocUpdates(context, targetPath, edits, originalIntent);
        } finally {
          stopDocs();
        }
        if (relatedDocs && successGuidance?.suggestedActions && relatedDocs.length > 0) {
          const top = relatedDocs[0];
          if (top?.filePath) {
            successGuidance.suggestedActions.push({
              pillar: 'doc_section',
              action: 'preview',
              target: top.filePath,
              headingPath: top.sectionPath
            });
            successGuidance.message = `${successGuidance.message} Related docs may need updates: ${top.filePath}.`;
          }
        }
      }

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
        relatedDocs,
        integrity: integrityReport,
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
    } finally {
      stopTotal();
    }


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

  private resolveTargetFiles(constraints: any, targets: string[]): string[] {
    const fromConstraints = Array.isArray(constraints?.targetFiles) ? constraints.targetFiles : [];
    const fallback = Array.isArray(targets) ? targets : [];
    const raw = fromConstraints.length > 0 ? fromConstraints : fallback;
    return raw
      .filter((value: any) => typeof value === 'string' && value.trim().length > 0)
      .map((value: string) => value.trim());
  }

  private extractEditFilePath(edit: any): string | undefined {
    const candidate = edit?.filePath ?? edit?.path;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    const targetCandidate = edit?.target;
    if (this.isLikelyFilePath(targetCandidate)) {
      return targetCandidate.trim();
    }
    return undefined;
  }

  private collectEditPaths(edits: any[]): string[] {
    const paths = new Set<string>();
    for (const edit of edits) {
      const filePath = this.extractEditFilePath(edit);
      if (filePath) {
        paths.add(filePath);
      }
    }
    return Array.from(paths);
  }

  private shouldUseBatch(constraints: any, targetFiles: string[], editPaths: string[]): boolean {
    const hasBatchFlag = Boolean(constraints?.batchMode);
    const hasMultipleTargets = targetFiles.length > 1;
    const hasMultipleEditPaths = editPaths.length > 1;
    if (hasMultipleTargets || hasMultipleEditPaths) {
      return true;
    }
    if (hasBatchFlag && (targetFiles.length > 0 || editPaths.length > 0)) {
      return true;
    }
    return false;
  }

  private mapEditsToFiles(args: {
    targetFiles: string[];
    rawEdits: any[];
    fallbackTarget?: string;
  }): { fileEdits?: Map<string, any[]>; error?: { errorCode: string; message: string } } {
    const { targetFiles, rawEdits, fallbackTarget } = args;
    const fileEdits = new Map<string, any[]>();

    const hasExplicitFile = rawEdits.some(edit => Boolean(this.extractEditFilePath(edit)));
    const canIndexMap = !hasExplicitFile && targetFiles.length > 0 && targetFiles.length === rawEdits.length;

    for (let i = 0; i < rawEdits.length; i++) {
      const edit = rawEdits[i];
      const explicitPath = this.extractEditFilePath(edit);
      const filePath = explicitPath ?? (canIndexMap ? targetFiles[i] : fallbackTarget);
      if (!filePath) {
        return {
          error: {
            errorCode: "MULTI_FILE_MAPPING_REQUIRED",
            message: "멀티파일 변경에서 각 edit의 filePath가 필요하거나, targetFiles와 edits 길이가 동일해야 합니다."
          }
        };
      }
      if (!fileEdits.has(filePath)) {
        fileEdits.set(filePath, []);
      }
      fileEdits.get(filePath)!.push(edit);
    }

    return { fileEdits };
  }

  private async executeBatchChange(args: {
    intent: ParsedIntent;
    context: OrchestrationContext;
    rawEdits: any[];
    targetFiles: string[];
    dryRun: boolean;
    includeImpact: boolean;
  }): Promise<any> {
    const { intent, context, rawEdits, targetFiles, dryRun, includeImpact } = args;
    const originalIntent = intent.originalIntent;

    if (rawEdits.length === 0) {
      return {
        success: false,
        message: "No edits provided for batch change.",
        guidance: {
          message: "Provide edits with explicit filePath or targetFiles mapping.",
          suggestedActions: []
        }
      };
    }

    const fallbackTarget = targetFiles.length === 1 ? targetFiles[0] : undefined;
    const mapped = this.mapEditsToFiles({ targetFiles, rawEdits, fallbackTarget });
    if (mapped.error || !mapped.fileEdits) {
      return {
        success: false,
        message: mapped.error?.message ?? "Batch mapping failed.",
        errorCode: mapped.error?.errorCode,
        guidance: {
          message: mapped.error?.message ?? "Provide filePath for each edit or align targetFiles with edits.",
          suggestedActions: []
        }
      };
    }

    const normalizedByFile = new Map<string, { edits: any[]; invalidEdits: any[] }>();
    for (const [filePath, editsForFile] of mapped.fileEdits.entries()) {
      const normalization = this.normalizeEdits(editsForFile, filePath);
      if (normalization.edits.length === 0) {
        return {
          success: false,
          message: `No valid edits provided for ${filePath}. Ensure targetContent/targetString and replacement/template are set.`,
          invalidEdits: normalization.invalidEdits,
          guidance: {
            message: `Use read to copy exact text or provide a shorter targetString for ${filePath}.`,
            suggestedActions: [
              { pillar: 'read', action: 'view_fragment', target: filePath },
              { pillar: 'change', action: 'retry', intent: originalIntent, target: filePath }
            ]
          }
        };
      }
      normalizedByFile.set(filePath, normalization);
    }

    if (dryRun) {
      return this.executeBatchDryRun({
        context,
        originalIntent,
        rawEdits,
        targetFiles,
        normalizedByFile,
        includeImpact,
        batchImpactLimit: this.resolveBatchImpactLimit(intent.constraints)
      });
    }

    return this.executeBatchApply({
      context,
      originalIntent,
      rawEdits,
      targetFiles,
      normalizedByFile,
      includeImpact,
      batchImpactLimit: this.resolveBatchImpactLimit(intent.constraints)
    });
  }

  private async executeBatchDryRun(args: {
    context: OrchestrationContext;
    originalIntent: string;
    rawEdits: any[];
    targetFiles: string[];
    normalizedByFile: Map<string, { edits: any[] }>;
    includeImpact: boolean;
    batchImpactLimit: number;
  }): Promise<any> {
    const { context, originalIntent, rawEdits, targetFiles, normalizedByFile, includeImpact, batchImpactLimit } = args;
    const results: Array<{ filePath: string; success: boolean; diff?: string; error?: string }> = [];
    const planSteps: Array<{ action: 'modify'; file: string; description: string; diff?: string }> = [];
    const diffBlocks: string[] = [];
    const impactReports: Array<{ filePath: string; preview?: any }> = [];
    let remainingImpact = includeImpact ? Math.max(0, batchImpactLimit) : 0;

    for (const [filePath, normalization] of normalizedByFile.entries()) {
      const stopEdit = metrics.startTimer("change.edit_coordinator_ms");
      let editResult: any;
      try {
        editResult = await this.runTool(context, 'edit_coordinator', {
          filePath,
          edits: normalization.edits,
          dryRun: true,
          options: { skipImpactPreview: remainingImpact <= 0 }
        });
      } finally {
        stopEdit();
      }
      if (!editResult.success) {
        const failureMessage = editResult.message ?? editResult.details?.message ?? "Batch dry run failed.";
        const failureGuidance = this.buildFailureGuidance({
          intent: originalIntent,
          targetPath: filePath,
          edits: normalization.edits,
          dryRun: true,
          failureMessage,
          autoCorrectionAttempts: []
        });
        results.push({ filePath, success: false, error: failureMessage });
        return {
          success: false,
          message: `Dry run failed for file ${filePath}: ${failureMessage}`,
          operation: "plan",
          results,
          guidance: failureGuidance
        };
      }

      results.push({ filePath, success: true, diff: editResult.diff });
      planSteps.push({
        action: 'modify' as const,
        file: filePath,
        description: originalIntent,
        diff: editResult.diff
      });
      if (remainingImpact > 0) {
        if (editResult?.impactPreview) {
          impactReports.push({ filePath, preview: editResult.impactPreview });
        }
        remainingImpact -= 1;
      }
      if (typeof editResult.diff === "string" && editResult.diff.length > 0) {
        diffBlocks.push(this.formatBatchDiff(filePath, editResult.diff));
      }
    }

    const successGuidance = {
      message: "Batch change plan generated. Review the diffs before applying.",
      suggestedActions: [
        {
          pillar: "change",
          action: "apply",
          intent: originalIntent,
          targetFiles,
          edits: rawEdits,
          options: { dryRun: false, batchMode: true }
        }
      ]
    };

    return {
      success: true,
      operation: "plan",
      diff: diffBlocks.join("\n\n"),
      plan: { steps: planSteps },
      results,
      impactReports: impactReports.length > 0 ? impactReports : undefined,
      guidance: successGuidance
    };
  }

  private async executeBatchApply(args: {
    context: OrchestrationContext;
    originalIntent: string;
    rawEdits: any[];
    targetFiles: string[];
    normalizedByFile: Map<string, { edits: any[] }>;
    includeImpact: boolean;
    batchImpactLimit: number;
  }): Promise<any> {
    const { context, originalIntent, rawEdits, targetFiles, normalizedByFile, includeImpact, batchImpactLimit } = args;
    const batchEdits: any[] = [];
    for (const [filePath, normalization] of normalizedByFile.entries()) {
      for (const edit of normalization.edits) {
        batchEdits.push({ ...edit, filePath });
      }
    }

    const stopEditCode = metrics.startTimer("change.edit_code_ms");
    let editResult: any;
    try {
      editResult = await this.runTool(context, "edit_code", {
        edits: batchEdits,
        dryRun: false
      });
    } finally {
      stopEditCode();
    }
    const success = editResult?.success !== false;
    const results = Array.isArray(editResult?.results) ? editResult.results.map((entry: any) => ({
      filePath: entry.filePath,
      success: entry.applied ?? entry.success ?? false,
      error: entry.error
    })) : undefined;

    const message = success ? undefined : (editResult?.message ?? "Batch apply failed.");
    const impactReports = success && includeImpact
      ? await this.collectBatchImpactReports(context, normalizedByFile, Math.max(0, batchImpactLimit))
      : [];
    const guidance = success
      ? {
          message: "Batch changes successfully applied.",
          suggestedActions: [{ pillar: "manage", action: "test" }]
        }
      : {
          message: message ?? "Batch apply failed.",
          suggestedActions: [
            { pillar: "change", action: "retry", intent: originalIntent, targetFiles, edits: rawEdits }
          ]
        };

    return {
      success,
      message,
      operation: "apply",
      results,
      impactReports: impactReports.length > 0 ? impactReports : undefined,
      editResult,
      transactionId: editResult?.operation?.id ?? "",
      rollbackAvailable: success,
      guidance
    };
  }

  private formatBatchDiff(filePath: string, diff: string): string {
    return `# ${filePath}\n${diff}`;
  }

  private resolveBatchImpactLimit(constraints: any): number {
    const raw = constraints?.batchImpactLimit ?? process.env.SMART_CONTEXT_CHANGE_BATCH_IMPACT_LIMIT;
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 0;
  }

  private async collectBatchImpactReports(
    context: OrchestrationContext,
    normalizedByFile: Map<string, { edits: any[] }>,
    limit: number
  ): Promise<Array<{ filePath: string; preview?: any; error?: string }>> {
    const results: Array<{ filePath: string; preview?: any; error?: string }> = [];
    if (limit <= 0) return results;
    let count = 0;
    for (const [filePath, normalization] of normalizedByFile.entries()) {
      if (count >= limit) break;
      try {
        const preview = await this.runTool(context, 'impact_analyzer', { target: filePath, edits: normalization.edits });
        results.push({ filePath, preview });
      } catch (error: any) {
        results.push({ filePath, error: error?.message ?? "impact_analyzer failed" });
      }
      count += 1;
    }
    return results;
  }

  private getMinLevenshteinTargetLength(): number {
    const raw = process.env.SMART_CONTEXT_CHANGE_MIN_LEVENSHTEIN_TARGET_LEN;
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 24;
  }

  private getMaxLevenshteinFileBytes(): number {
    const raw = process.env.SMART_CONTEXT_CHANGE_MAX_LEVENSHTEIN_FILE_BYTES;
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 262144;
  }

  private async suggestDocUpdates(
    context: OrchestrationContext,
    targetPath: string,
    edits: any[],
    intentText: string
  ): Promise<Array<{ filePath: string; sectionPath?: string[]; chunkId?: string; packId?: string; score?: number; preview?: string; section?: { content: string; resolvedHeadingPath?: string[] } }> | undefined> {
    const queries = new Set<string>();
    const basename = path.basename(targetPath);
    const ext = path.extname(basename);
    const stem = ext ? basename.slice(0, -ext.length) : basename;

    queries.add(targetPath);
    if (basename) queries.add(basename);
    if (stem && stem.length >= 3) queries.add(stem);

    const editTokens = edits
      .map(edit => edit?.targetString ?? edit?.search ?? edit?.from)
      .filter((value: any) => typeof value === 'string' && value.length > 0) as string[];
    for (const token of editTokens.slice(0, 2)) {
      const trimmed = token.trim();
      if (trimmed.length >= 3 && trimmed.length <= 80) {
        queries.add(trimmed);
      }
    }

    const queryList = Array.from(queries).filter(q => q.length >= 3);
    if (queryList.length === 0) return undefined;

    const aggregated: Array<{ filePath: string; sectionPath?: string[]; chunkId?: string; packId?: string; score?: number; preview?: string; section?: { content: string; resolvedHeadingPath?: string[] } }> = [];
    for (const query of queryList.slice(0, 3)) {
      try {
        const result = await this.runTool(context, 'doc_search', {
          query,
          output: "compact",
          maxResults: 8,
          includeEvidence: false
        });
        const sections = Array.isArray(result?.results) ? result.results : [];
        for (const section of sections) {
          if (!section?.filePath) continue;
          aggregated.push({
            chunkId: section.id,
            filePath: section.filePath,
            sectionPath: section.sectionPath,
            packId: result?.pack?.packId,
            score: section.scores?.final,
            preview: section.preview
          });
        }
      } catch {
        // ignore doc search failures
      }
    }

    if (aggregated.length === 0) return undefined;
    const seen = new Set<string>();
    const deduped = aggregated.filter(item => {
      const key = `${item.filePath}::${item.chunkId ?? ''}::${(item.sectionPath ?? []).join('/')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);

    return this.attachDocSections(context, deduped);
  }

  private async attachDocSections(
    context: OrchestrationContext,
    docs: Array<{ filePath: string; sectionPath?: string[]; chunkId?: string; packId?: string; score?: number; preview?: string; section?: { content: string; resolvedHeadingPath?: string[] } }>
  ) {
    const output: Array<{ filePath: string; sectionPath?: string[]; chunkId?: string; packId?: string; score?: number; preview?: string; section?: { content: string; resolvedHeadingPath?: string[] } }> = [];
    const enabled = process.env.SMART_CONTEXT_ATTACH_DOC_SECTIONS === "true";
    const sectionLimit = enabled ? Number.parseInt(process.env.SMART_CONTEXT_ATTACH_DOC_SECTIONS_MAX ?? "0", 10) : 0;
    let attached = 0;
    for (const doc of docs) {
      const next = { ...doc };
      if (sectionLimit > 0 && attached < sectionLimit && Array.isArray(doc.sectionPath) && doc.sectionPath.length > 0) {
        try {
          const maxChars = Number.parseInt(process.env.SMART_CONTEXT_DOC_SECTION_MAX_CHARS ?? "4000", 10);
          const section = await this.runTool(context, 'doc_section', {
            filePath: doc.filePath,
            headingPath: doc.sectionPath,
            includeSubsections: false,
            mode: "preview",
            maxChars
          });
          if (section?.success && typeof section?.content === 'string') {
            next.section = {
              content: section.content,
              resolvedHeadingPath: section.resolvedHeadingPath
            };
            attached += 1;
          }
        } catch {
          // ignore
        }
      }
      output.push(next);
    }
    return output;
  }

  private shouldSuggestDocs(constraints: any): boolean {
    if (constraints?.suggestDocs === true) return true;
    return process.env.SMART_CONTEXT_CHANGE_SUGGEST_DOCS === "true";
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

  private formatIntegrityBlockMessage(findings?: IntegrityFinding[]): string {
    const items = Array.isArray(findings) ? findings.slice(0, 3) : [];
    if (items.length === 0) {
      return "Integrity check blocked. Resolve conflicts before applying.";
    }
    const summary = items
      .map((finding, index) => `${index + 1}) ${this.summarizeIntegrityFinding(finding)}`)
      .join("; ");
    return `Integrity check blocked. Fix first: ${summary}`;
  }

  private summarizeIntegrityFinding(finding: IntegrityFinding): string {
    const left = this.compactIntegrityText(finding.claimA ?? "");
    const right = this.compactIntegrityText(finding.claimB ?? "");
    return right ? `${left} vs ${right}` : left;
  }

  private compactIntegrityText(text: string, max = 80): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 3)}...`;
  }

  /**
   * ADR-042-005: Phase B2 - V2 batch change execution using EditResolver
   */
  private async executeV2BatchChange(args: {
    intent: ParsedIntent;
    context: OrchestrationContext;
    rawEdits: any[];
    targetFiles: string[];
    dryRun: boolean;
    includeImpact: boolean;
    v2Mode: string;
  }): Promise<any> {
    const { intent, context, rawEdits, targetFiles, dryRun, includeImpact, v2Mode } = args;
    const stopResolve = metrics.startTimer("change.resolve_ms");
    
    try {
      // Group edits by file
      const editsByFile = new Map<string, any[]>();
      for (const edit of rawEdits) {
        const filePath = edit.filePath || targetFiles[0];
        if (!filePath) {
          throw new Error("Cannot determine target file for edit");
        }
        if (!editsByFile.has(filePath)) {
          editsByFile.set(filePath, []);
        }
        editsByFile.get(filePath)!.push(edit);
      }

      // Resolve all edits
      const resolveOptions = {
        allowAmbiguousAutoPick: ConfigurationManager.getAllowAmbiguousAutoPick(),
        timeoutMs: ConfigurationManager.getResolveTimeoutMs()
      };

      const allResolvedEdits: any[] = [];
      const allErrors: ResolveError[] = [];

      // Create EditResolver instance
      const editResolver = this.getEditResolver();

      for (const [filePath, edits] of editsByFile.entries()) {
        const result = await editResolver.resolveAll(filePath, edits, resolveOptions);
        
        if (!result.success && result.errors) {
          allErrors.push(...result.errors);
        } else if (result.success && result.resolvedEdits) {
          for (const resolved of result.resolvedEdits) {
            allResolvedEdits.push({
              ...resolved,
              filePath
            });
          }
        }
      }

      stopResolve();

      // If any errors, format guidance and return failure
      if (allErrors.length > 0) {
        const guidance = this.formatResolveErrors(allErrors, intent.originalIntent, targetFiles);
        return {
          success: false,
          dryRun,
          message: guidance.message,
          suggestedActions: guidance.suggestedActions,
          diagnostics: { resolveErrors: allErrors }
        };
      }

      // dryrun mode: return resolved edits without applying
      if (v2Mode === 'dryrun') {
        return {
          success: true,
          dryRun: true,
          message: `[DRYRUN] Resolved ${allResolvedEdits.length} edits successfully`,
          resolvedEdits: allResolvedEdits
        };
      }

      // Apply resolved edits
      const stopApply = metrics.startTimer("change.apply_ms");
      
      const editCoordinator = this.getEditCoordinator();
      const applyResult = await editCoordinator.applyBatchResolvedEdits(
        allResolvedEdits.map(r => ({
          filePath: r.filePath,
          resolvedEdits: [r]
        })),
        dryRun
      );

      stopApply();

      // Extract changed files from resolved edits (since applyResult doesn't have results array)
      const changedFiles = allResolvedEdits.map(r => r.filePath).filter((v, i, a) => a.indexOf(v) === i);

      let message = `${changedFiles.length} file(s) modified`;
      if (dryRun) {
        message = `[DRYRUN] ${message}`;
      }

      return {
        success: applyResult.success,
        dryRun,
        message: applyResult.message || message,
        changedFiles,
        rollbackAvailable: false // EditCoordinator doesn't expose transactionId in result
      };

    } catch (error: any) {
      stopResolve();
      return {
        success: false,
        dryRun,
        message: `V2 batch change failed: ${error.message}`,
        error: error.message
      };
    }
  }

  /**
   * ADR-042-005: Format ResolveError[] into user guidance
   */
  private formatResolveErrors(
    errors: ResolveError[],
    intent: string,
    targetFiles: string[]
  ): { message: string; suggestedActions: any[] } {
    const messages: string[] = [];
    const actions: any[] = [];

    // Group errors by type
    const ambiguousErrors = errors.filter(e => e.errorCode === 'AMBIGUOUS_MATCH');
    const timeoutErrors = errors.filter(e => e.errorCode === 'RESOLVE_TIMEOUT');
    const otherErrors = errors.filter(e => e.errorCode !== 'AMBIGUOUS_MATCH' && e.errorCode !== 'RESOLVE_TIMEOUT');

    if (ambiguousErrors.length > 0) {
      const first = ambiguousErrors[0];
      messages.push(`Ambiguous match detected.`);
      
      // Suggest lineRange narrowing
      if (first.suggestion?.lineRange) {
        messages.push(`Try narrowing to lines ${first.suggestion.lineRange.start}-${first.suggestion.lineRange.end}.`);
        actions.push({
          pillar: 'read',
          action: 'view_fragment',
          target: first.filePath,
          options: {
            view: 'fragment',
            lineRange: `${first.suggestion.lineRange.start}-${first.suggestion.lineRange.end}`
          }
        });
      } else {
        actions.push({
          pillar: 'read',
          action: 'view_file',
          target: first.filePath
        });
      }
    }

    if (timeoutErrors.length > 0) {
      messages.push(`Resolve timeout (>${ConfigurationManager.getResolveTimeoutMs()}ms). Provide more precise targetString.`);
    }

    if (otherErrors.length > 0) {
      const first = otherErrors[0];
      messages.push(`Resolve failed: ${first.message}`);
    }

    // Default retry actions
    actions.push({
      pillar: 'change',
      action: 'retry',
      intent,
      target: targetFiles[0]
    });

    actions.push({
      pillar: 'write',
      action: 'overwrite',
      intent: `Rewrite ${targetFiles[0]} with corrected content`,
      targetPath: targetFiles[0]
    });

    return {
      message: messages.join(' '),
      suggestedActions: actions
    };
  }

}

function shouldBlockIntegrity(
  mode: string,
  blockPolicy: string | undefined,
  report: IntegrityReport
): boolean {
  if (!report?.summary) return false;
  if (blockPolicy === "off") return false;
  const highCount = report.summary.bySeverity?.high ?? 0;
  const warnCount = report.summary.bySeverity?.warn ?? 0;
  if (mode === "strict") {
    return highCount + warnCount > 0;
  }
  return highCount > 0;
}
