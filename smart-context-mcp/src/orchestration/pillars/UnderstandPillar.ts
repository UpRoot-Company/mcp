
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


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

    // 1. 초기 검색 수행
    let searchResult = { results: [] as any[] };
    if (explicitPath && !/[\\/]/.test(explicitPath)) {
      const fileMatches = await this.runTool(context, 'search_project', {
        query: explicitPath,
        type: 'filename',
        maxResults: 5
      });
      if (fileMatches?.results?.length) {
        resolvedPath = fileMatches.results[0].path;
      }
    }

    if (!resolvedPath) {
      searchResult = await this.runTool(context, 'search_project', { 
        query: subject, 
        type: constraints.scope === 'project' ? 'file' : 'symbol',
        maxResults: 5
      });
      if (!searchResult.results || searchResult.results.length === 0) {
        searchResult = await this.runTool(context, 'search_project', { 
          query: subject, 
          type: 'file',
          maxResults: 5
        });
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
      });
      const match = symbolMatches?.results?.find((result: any) => result.path === filePath) ?? symbolMatches?.results?.[0];
      if (match?.symbol?.name) {
        symbolName = match.symbol.name;
        if (!resolvedPath && match?.path) {
          filePath = match.path;
        }
      }
    }

        // 2. Parallel Deep Data Collection (Eager Loading)
    const [skeleton, calls, deps, hotSpots, profile] = await Promise.all([
      this.runTool(context, 'read_code', { filePath, view: 'skeleton' }),
      includeCalls && symbolName ?
        this.runTool(context, 'analyze_relationship', { 
          target: symbolName,
          contextPath: filePath,
          mode: 'calls', 
          direction: 'both', 
          maxDepth: depth === 'deep' ? 3 : 1 
        }) : Promise.resolve(null),
      includeDependencies ?
        this.runTool(context, 'analyze_relationship', { 
          target: filePath, 
          mode: 'dependencies', 
          direction: 'both' 
        }) : Promise.resolve(null),
      include.hotSpots === true
        ? this.runTool(context, 'hotspot_detector', {})
        : Promise.resolve([]),
      this.runTool(context, 'file_profiler', { filePath })
    ]);


        // 3. Synthesize Response (Advanced synthesis in Phase 3)
    const status = includeCalls && !symbolName ? 'partial_success' : 'ok';
    return {
      success: true,
      status,
      summary: `Analysis results for "${subject}".`,
      primaryFile: filePath,
      structure: skeleton,
      skeleton,
      symbols: profile?.structure?.symbols ?? [],
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
          : 'Code structure analyzed. Enable include.{callGraph,dependencies,hotSpots,pageRank} for deeper analysis.',
        suggestedActions: [
          { pillar: 'read', action: 'view_full', target: filePath },
          { pillar: 'understand', action: 'expand', goal: filePath, include: { callGraph: true, dependencies: true, hotSpots: true, pageRank: true } }
        ]
      }
    };

  }

  private extractPath(text: string): string | null {
    if (!text) return null;
    const pathPattern = /([A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|json|md))/i;
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
