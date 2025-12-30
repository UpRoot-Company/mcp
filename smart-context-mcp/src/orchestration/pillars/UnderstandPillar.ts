
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';
import { BudgetManager } from '../BudgetManager.js';
import { analyzeQuery, isStrongQuery } from '../../engine/search/QueryMetrics.js';


export class UnderstandPillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent } = intent;
    const subject = constraints.goal || targets[0] || originalIntent;
    const depth = constraints.depth || 'standard';
    const include = constraints.include ?? {};
    const includeDependencies = include.dependencies === true || include.pageRank === true;
    const includeCalls = include.callGraph === true;
    const explicitPath = this.extractPath(subject) ?? (typeof originalIntent === 'string' ? this.extractPath(originalIntent) : null);
    const symbolHint = this.extractSymbol(subject) ?? (typeof originalIntent === 'string' ? this.extractSymbol(originalIntent) : null);
    let resolvedPath = explicitPath;
    const progressEnabled = this.shouldLogProgress(constraints);
    const progress = { enabled: progressEnabled, label: 'Understand' };
    const startedAt = Date.now();

    this.progressLog(progressEnabled, `Start subject="${subject}" depth=${depth}.`);

    // 1. 초기 검색 수행
    let searchResult = { results: [] as any[] };
    if (explicitPath && !/[\\/]/.test(explicitPath)) {
      const fileMatches = await this.runTool(context, 'search_project', {
        query: explicitPath,
        type: 'filename',
        maxResults: 5
      }, progress);
      if (fileMatches?.results?.length) {
        resolvedPath = fileMatches.results[0].path;
      }
    }

    if (!resolvedPath) {
      searchResult = await this.runTool(context, 'search_project', { 
        query: subject, 
        type: constraints.scope === 'project' ? 'file' : 'symbol',
        maxResults: 5
      }, progress);
      if (!searchResult.results || searchResult.results.length === 0) {
        searchResult = await this.runTool(context, 'search_project', { 
          query: subject, 
          type: 'file',
          maxResults: 5
        }, progress);
      }
    }

    if ((!searchResult.results || searchResult.results.length === 0) && !resolvedPath) {
      return { success: false, status: 'no_results', summary: 'No relevant code found.', results: [] };
    }

    const primaryResult = resolvedPath ? { path: resolvedPath } : searchResult.results[0];
    let filePath = primaryResult.path;
    let symbolName = primaryResult?.symbol?.name;
    if (includeCalls && !symbolName && symbolHint) {
      const symbolMatches = await this.runTool(context, 'search_project', {
        query: symbolHint,
        type: 'symbol',
        maxResults: 10
      }, progress);
      const match = symbolMatches?.results?.find((result: any) => result.path === filePath) ?? symbolMatches?.results?.[0];
      if (match?.symbol?.name) {
        symbolName = match.symbol.name;
        if (!resolvedPath && match?.path) {
          filePath = match.path;
        }
      }
    }

    this.progressLog(progressEnabled, `Resolved filePath="${filePath}" symbol="${symbolName ?? ''}".`);

    const metrics = analyzeQuery(subject);
    const isDocument = this.isDocumentPath(filePath);
    let projectStats: any = undefined;
    try {
      projectStats = await this.runTool(context, 'project_stats', {}, progress);
    } catch {
      projectStats = undefined;
    }
    const budget = BudgetManager.create({
      category: 'understand',
      queryLength: metrics.length,
      tokenCount: metrics.tokenCount,
      strongQuery: metrics.strong,
      includeGraph: includeDependencies || includeCalls,
      includeHotSpots: include.hotSpots,
      projectStats: { fileCount: projectStats?.fileCount }
    });

    // 2. Staged Data Collection (Budget-Aware)
    let skeleton: any = '';
    let docProfile: any = undefined;
    if (isDocument) {
      const docAnalysis = await this.runTool(context, 'doc_analyze', { filePath }, progress);
      skeleton = docAnalysis?.skeleton ?? '';
      docProfile = docAnalysis?.profile;
    } else {
      skeleton = await this.runTool(context, 'read_code', { filePath, view: 'skeleton' }, progress);
    }
    const profile = await this.runTool(context, 'file_profiler', { filePath }, progress);

    let calls: any = null;
    let deps: any = null;
    let hotSpots: any = [];
    let degraded = false;
    let refinementReason: string | undefined = undefined;

    const allowGraphs = !isDocument && isStrongQuery(metrics) && (budget.profile !== 'safe' || includeCalls || includeDependencies || include.hotSpots === true);
    if (isDocument && (includeCalls || includeDependencies || include.hotSpots === true)) {
      degraded = true;
      refinementReason = refinementReason ?? 'document_file';
    }
    if (includeCalls && symbolName && allowGraphs) {
      calls = await this.runTool(context, 'analyze_relationship', {
        target: symbolName,
        contextPath: filePath,
        mode: 'calls',
        direction: 'both',
        maxDepth: depth === 'deep' ? 3 : 1
      }, progress);
    } else if (includeCalls && symbolName && !allowGraphs) {
      degraded = true;
      refinementReason = refinementReason ?? 'budget_exceeded';
    }

    if (includeDependencies && allowGraphs) {
      deps = await this.runTool(context, 'analyze_relationship', {
        target: filePath,
        mode: 'dependencies',
        direction: 'both'
      }, progress);
    } else if (includeDependencies && !allowGraphs) {
      degraded = true;
      refinementReason = refinementReason ?? 'budget_exceeded';
    }

    if (include.hotSpots === true && allowGraphs) {
      hotSpots = await this.runTool(context, 'hotspot_detector', {}, progress);
    } else if (include.hotSpots === true && !allowGraphs) {
      degraded = true;
      refinementReason = refinementReason ?? 'budget_exceeded';
    }


        // 3. Synthesize Response (Advanced synthesis in Phase 3)
    const status = includeCalls && !symbolName ? 'partial_success' : (degraded ? 'partial_success' : 'ok');
    const elapsedMs = Date.now() - startedAt;
    this.progressLog(progressEnabled, `Completed in ${elapsedMs}ms.`);
    return {
      success: true,
      status,
      summary: `Analysis results for "${subject}".`,
      primaryFile: filePath,
      structure: skeleton,
      skeleton,
      symbols: isDocument ? [] : (profile?.structure?.symbols ?? []),
      document: docProfile
        ? { title: docProfile.title, outline: docProfile.outline ?? [], links: docProfile.links ?? [] }
        : undefined,
      callGraph: calls ?? undefined,
      dependencies: Array.isArray(deps?.edges) ? deps.edges : [],
      relationships: {
        calls: calls,
        dependencies: deps
      },
      hotSpots,
      report: {
        summary: `Analysis summary for ${filePath}.`,
        architecturalRole: 'utility',
        complexity: {
          loc: profile?.metadata?.lineCount ?? 0,
          branches: 0,
          dependencies: Array.isArray(deps?.edges) ? deps.edges.length : 0,
          fanIn: Array.isArray(deps?.edges) ? deps.edges.filter((e: any) => e?.to === filePath).length : 0,
          fanOut: Array.isArray(deps?.edges) ? deps.edges.filter((e: any) => e?.from === filePath).length : 0
        },
        risks: [],
        recommendations: []
      },

      guidance: {
        message: includeCalls && !symbolName
          ? 'Code structure analyzed. Call graph skipped (no symbol match).'
          : (degraded
              ? (refinementReason === 'document_file'
                  ? 'Document structure analyzed. Graph analysis is not available for documents.'
                  : 'Partial analysis due to budget limits. Provide a stronger query or reduce scope for deep analysis.')
              : 'Code structure analyzed. Enable include.{callGraph,dependencies,hotSpots,pageRank} for deeper analysis.'),
        suggestedActions: [
          { pillar: 'read', action: 'view_full', target: filePath },
          { pillar: 'understand', action: 'expand', goal: filePath, include: { callGraph: true, dependencies: true, hotSpots: true, pageRank: true } }
        ]
      },
      degraded,
      budget,
      refinement: {
        stage: allowGraphs ? 'graph' : 'skeleton',
        reason: refinementReason
      }
    };

  }

  private extractPath(text: string): string | null {
    if (!text) return null;
    const pathPattern = /([A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|json|md|mdx))/i;
    const match = text.match(pathPattern);
    if (match) return match[1];
    if (/\s/.test(text)) {
      const tokens = text.split(/\s+/).map(token =>
        token.replace(/^[\"'`(]+/, "").replace(/[\"'`),.;]+$/, "")
      );
      for (const token of tokens) {
        if (!token) continue;
        if (pathPattern.test(token)) {
          return token;
        }
        if (/[\\/]/.test(token) && /\.[a-z0-9]+$/i.test(token)) {
          return token;
        }
      }
      return null;
    }
    if (/[\\/]/.test(text) && /\.[a-z0-9]+$/i.test(text.trim())) {
      return text.trim();
    }
    return null;
  }

  private isDocumentPath(filePath: string): boolean {
    return /\.(md|mdx)$/i.test(filePath);
  }

  private extractSymbol(text: string): string | null {
    if (!text) return null;
    const explicitMatch = text.match(/\b(?:method|function|class|symbol)\s+([A-Za-z_$][\w$]*)/i);
    if (explicitMatch) return explicitMatch[1];
    const tokens = text.split(/\s+/).map(token =>
      token.replace(/^[\"'`(]+/, "").replace(/[\"'`),.;]+$/, "")
    );
    for (const token of tokens) {
      if (!token || /[\\/]/.test(token)) continue;
      const hashMatch = token.match(/^[A-Za-z_$][\w$]*#([A-Za-z_$][\w$]*)$/);
      if (hashMatch) return hashMatch[1];
      const dotMatch = token.match(/^[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)$/);
      if (dotMatch) {
        const candidate = dotMatch[1].toLowerCase();
        if (!['ts', 'tsx', 'js', 'jsx', 'json', 'md'].includes(candidate)) {
          return dotMatch[1];
        }
      }
    }
    return null;
  }

  private async runTool(
    context: OrchestrationContext,
    tool: string,
    args: any,
    progress?: { enabled: boolean; label: string }
  ) {
    const started = Date.now();
    if (progress?.enabled) {
      console.info(`[${progress.label}] ${tool} start.`);
    }
    const output = await this.registry.execute(tool, args);
    const duration = Date.now() - started;
    if (progress?.enabled) {
      console.info(`[${progress.label}] ${tool} done in ${duration}ms.`);
    }
    context.addStep({
      id: `${tool}_${context.getFullHistory().length + 1}`,
      tool,
      args,
      output,
      status: output?.success === false || output?.isError ? 'failure' : 'success',
      duration
    });
    return output;
  }

  private shouldLogProgress(constraints: any): boolean {
    const flag = process.env.SMART_CONTEXT_PROGRESS_LOGS;
    return constraints?.progress === true || flag === 'true' || flag === '1';
  }

  private progressLog(enabled: boolean, message: string): void {
    if (!enabled) return;
    console.info(`[Understand] ${message}`);
  }
}
