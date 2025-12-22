
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class NavigatePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent } = intent;
    const target = targets[0] || originalIntent;
    const limit = constraints.limit || 10;
    const contextMode = constraints.context ?? 'all';

    const searchArgs: any = {
      query: target,
      maxResults: limit
    };
    if (contextMode === 'definitions') {
      searchArgs.type = 'symbol';
    }
    const results = await this.runTool(context, 'search_project', searchArgs);

    let rawResults = results?.results ?? [];
    rawResults = await this.applyContextFilter(context, target, contextMode, rawResults, limit);
    const hotSpotSet = await this.loadHotSpotSet(context, rawResults);
    const pageRankScores = await this.loadPageRankScores(context, rawResults);
    const relatedSymbols = await this.loadRelatedSymbols(context, target);

    const locations = rawResults.map((item: any) => {
      const filePath = item.path ?? '';
      const snippet = item.context ?? '';
      const line = this.extractLine(item);
      const relevance = item.score ?? 0;
      const isTest = this.isTestPath(filePath);
      const isDoc = this.isDocPath(filePath);
      const inferredType = item.type === 'usage'
        ? 'usage'
        : (item.type === 'symbol' ? 'exact' : (relevance >= 0.9 ? 'exact' : 'related'));
      const type = isTest ? 'test' : (isDoc ? 'doc' : inferredType);
      return {
        filePath,
        line,
        snippet,
        relevance,
        type,
        pageRank: pageRankScores.get(filePath),
        isHotSpot: hotSpotSet.has(filePath)
      };
    });

    const response: any = {
      locations,
      relatedSymbols,
      codePreview: locations[0]?.snippet,
    };

    // Eager Loading: 단일 결과인 경우 Smart File Profile 추가
    if (rawResults.length === 1) {
      const primary = rawResults[0];
      const profile = await this.runTool(context, 'file_profiler', { filePath: primary.path });
      response.smartProfile = profile;
      if (primary?.path) {
        const skeleton = await this.runTool(context, 'read_code', { filePath: primary.path, view: 'skeleton' });
        if (typeof skeleton === 'string') {
          response.codePreview = skeleton;
        }
      }
    }

    return response;
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

  private async loadHotSpotSet(context: OrchestrationContext, results: any[]): Promise<Set<string>> {
    if (results.length === 0) return new Set();
    if (results.length > 10) return new Set();
    const hotSpots = await this.runTool(context, 'hotspot_detector', {});
    const set = new Set<string>();
    if (Array.isArray(hotSpots)) {
      for (const spot of hotSpots) {
        if (spot?.filePath) set.add(spot.filePath);
      }
    }
    return set;
  }

  private async loadPageRankScores(context: OrchestrationContext, results: any[]): Promise<Map<string, number>> {
    if (results.length !== 1) return new Map();
    const targetPath = results[0]?.path;
    if (!targetPath) return new Map();
    const deps = await this.runTool(context, 'analyze_relationship', {
      target: targetPath,
      mode: 'dependencies',
      direction: 'both'
    });
    const edges = Array.isArray(deps?.edges) ? deps.edges : [];
    return this.computePageRankFromEdges(edges);
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

  private async loadRelatedSymbols(context: OrchestrationContext, target: string): Promise<string[]> {
    if (!target) return [];
    const matches = await this.runTool(context, 'search_project', {
      query: target,
      type: 'symbol',
      maxResults: 5
    });
    const results = matches?.results ?? [];
    return results.map((item: any) => item?.context ?? item?.path ?? '').filter(Boolean);
  }

  private async applyContextFilter(
    context: OrchestrationContext,
    target: string,
    contextMode: string,
    results: any[],
    limit: number
  ): Promise<any[]> {
    if (contextMode === 'all' || contextMode === 'definitions') return results;

    if (contextMode === 'usages') {
      const symbolMatch = await this.runTool(context, 'search_project', {
        query: target,
        type: 'symbol',
        maxResults: 1
      });
      const symbolResult = symbolMatch?.results?.[0];
      const symbolName = symbolResult?.symbol?.name ?? target;
      const definitionPath = symbolResult?.path;
      if (definitionPath) {
        const references = await this.runTool(context, 'reference_finder', {
          symbolName,
          definitionPath
        });
        const refs = references?.references ?? [];
        if (Array.isArray(refs) && refs.length > 0) {
          return refs.slice(0, limit).map((ref: any) => ({
            type: 'usage',
            path: ref.filePath ?? '',
            score: 1,
            context: ref.snippet ?? ref.text,
            line: ref.line
          }));
        }
      }
      return results;
    }

    if (contextMode === 'tests') {
      const filtered = results.filter((item: any) => this.isTestPath(item?.path ?? ''));
      if (filtered.length > 0) return filtered;
      const fallback = await this.runTool(context, 'search_project', {
        query: target,
        maxResults: limit,
        includeGlobs: ['**/*.test.*', '**/__tests__/**', '**/tests/**']
      });
      return fallback?.results ?? [];
    }

    if (contextMode === 'docs') {
      const filtered = results.filter((item: any) => this.isDocPath(item?.path ?? ''));
      if (filtered.length > 0) return filtered;
      const fallback = await this.runTool(context, 'search_project', {
        query: target,
        maxResults: limit,
        includeGlobs: ['**/*.md', '**/docs/**']
      });
      return fallback?.results ?? [];
    }

    return results;
  }

  private isTestPath(filePath: string): boolean {
    return /\/tests?\//i.test(filePath) || /\.test\./i.test(filePath);
  }

  private isDocPath(filePath: string): boolean {
    return /\.md$/i.test(filePath) || /\/docs\//i.test(filePath);
  }

  private extractLine(item: any): number {
    if (typeof item?.line === 'number') return item.line;
    const symbolLine = item?.symbol?.range?.startLine;
    if (typeof symbolLine === 'number') return symbolLine;
    return 0;
  }
}
