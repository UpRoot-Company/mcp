
export interface Insight {
  type: 'architecture' | 'risk' | 'optimization' | 'maintenance' | 'dependency';
  severity: 'low' | 'medium' | 'high';
  observation: string;      // What was found
  implication: string;      // Why it matters
  risk?: string;            // Potential risks
  actionSuggestion: string; // Recommended next tool call
  affectedFiles: string[];
  confidence: number;       // 0-1
}

export interface SynthesizedInsights {
  overview: {
    filesAnalyzed: number;
    symbolsDiscovered: number;
    generatedAt: string;
  };
  insights: Insight[];
  pageRankSummary?: {
    coverage: number;
    topNodes: Array<{ id: string; score: number }>;
  };
  hotSpotSummary?: {
    count: number;
    topFiles: Array<{ filePath: string; count: number }>;
  };
  impactSummary?: {
    riskCounts: { high: number; medium: number; low: number };
    impactedFiles: string[];
  };
  visualization?: string;  // Mermaid diagram
}

/**
 * InsightSynthesizer: 로우 데이터를 분석하여 아키텍처적 통찰과 리스크를 추출합니다.
 */
export class InsightSynthesizer {
  /**
   * 수집된 분석 데이터들로부터 종합적인 인사이트를 생성합니다.
   */
  public synthesize(data: {
    skeletons: any[];
    calls: any;
    dependencies: any;
    hotSpots?: any[];
    pageRank?: Map<string, number>;
    impactPreviews?: any[];
  }): SynthesizedInsights {
    const insights: Insight[] = [];
    const derivedPageRank = data.pageRank ?? this.computePageRankFromCalls(data.calls);

    // 1. God Class/Module Detection (High Centrality)
    if (derivedPageRank) {
      this.detectGodModules(derivedPageRank, insights);
    }

    // 2. High Blast Radius Detection (Complex Dependencies)
    if (data.dependencies) {
      this.detectHighImpactAreas(data.dependencies, insights);
      this.detectHighBlastRadius(data.dependencies, insights);
    }

    // 3. HotSpot Concentration (Maintenance Risk)
    if (data.hotSpots) {
      this.detectMaintenanceRisks(data.hotSpots, insights);
      this.detectHotSpotConcentration(data.hotSpots, insights);
    }

    // 4. Circular Dependencies
    if (data.dependencies) {
      this.detectCircularDependencies(data.dependencies, insights);
    }

    // 5. Impact Risk Integration
    if (data.impactPreviews && data.impactPreviews.length > 0) {
      this.detectImpactRisks(data.impactPreviews, insights);
    }

    const pageRankSummary = this.buildPageRankSummary(derivedPageRank);
    const hotSpotSummary = this.buildHotSpotSummary(data.hotSpots ?? []);
    const impactSummary = this.buildImpactSummary(data.impactPreviews ?? []);

    return {
      overview: {
        filesAnalyzed: data.skeletons.length,
        symbolsDiscovered: this.countSymbols(data.skeletons),
        generatedAt: new Date().toISOString()
      },
      insights,
      pageRankSummary,
      hotSpotSummary,
      impactSummary,
      visualization: this.generateMermaid(data)
    };
  }

  private detectGodModules(pageRank: Map<string, number>, insights: Insight[]): void {
    for (const [path, score] of pageRank.entries()) {
      if (score > 0.8) {
        insights.push({
          type: 'architecture',
          severity: 'high',
          observation: `Module "${path}" shows very high centrality (PageRank: ${score.toFixed(2)}).`,
          implication: 'This module likely acts as a "God Module" with too many responsibilities.',
          risk: 'Modifying this file may have broad side effects across the project.',
          actionSuggestion: 'Consider refactoring into smaller, specialized components.',
          affectedFiles: [path],
          confidence: 0.9
        });
      }
    }
  }

  private detectHighImpactAreas(deps: any, insights: Insight[]): void {
    // 의존성 그래프 분석 로직 (간소화)
    if (deps.nodes?.length > 20) {
      insights.push({
        type: 'risk',
        severity: 'medium',
        observation: 'Complex dependency cluster detected.',
        implication: 'Tight coupling between modules increases refactoring difficulty.',
        actionSuggestion: 'Use "analyze_relationship" with depth 3 to explore sub-clusters.',
        affectedFiles: [],
        confidence: 0.8
      });
    }
  }

  private detectMaintenanceRisks(hotSpots: any[], insights: Insight[]): void {
    if (hotSpots.length > 5) {
      insights.push({
        type: 'maintenance',
        severity: 'medium',
        observation: `${hotSpots.length} active hotspots identified in this area.`,
        implication: 'This region changes frequently and is prone to regression bugs.',
        actionSuggestion: 'Ensure high test coverage before making changes.',
        affectedFiles: hotSpots.map(h => h.filePath),
        confidence: 0.85
      });
    }
  }

  private detectHighBlastRadius(deps: any, insights: Insight[]): void {
    const edges = this.extractDependencyEdges(deps);
    if (edges.length === 0) return;

    const outDegree = new Map<string, number>();
    for (const edge of edges) {
      outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    }

    const high = Array.from(outDegree.entries()).filter(([, count]) => count >= 10);
    if (high.length === 0) return;

    insights.push({
      type: 'risk',
      severity: 'high',
      observation: `${high.length} files show large dependency fan-out.`,
      implication: 'Changes in these files may impact many downstream modules.',
      risk: 'Broad regression risk without targeted tests.',
      actionSuggestion: 'Use change with dryRun and includeImpact before editing.',
      affectedFiles: high.map(([path]) => path),
      confidence: 0.9
    });
  }

  private detectHotSpotConcentration(hotSpots: any[], insights: Insight[]): void {
    const byFile = new Map<string, number>();
    for (const hs of hotSpots) {
      const file = hs?.filePath;
      if (!file) continue;
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
    }
    const concentrated = Array.from(byFile.entries()).filter(([, count]) => count >= 3);
    if (concentrated.length > 0) {
      insights.push({
        type: 'maintenance',
        severity: 'medium',
        observation: `${concentrated.length} files show concentrated hotspots.`,
        implication: 'Hotspot concentration indicates potential maintenance risk.',
        actionSuggestion: 'Consider refactoring or adding targeted tests.',
        affectedFiles: concentrated.map(([path]) => path),
        confidence: 0.8
      });
    }
  }

  private detectCircularDependencies(deps: any, insights: Insight[]): void {
    const edges = this.extractDependencyEdges(deps);
    if (edges.length === 0) return;

    const graph = new Map<string, string[]>();
    for (const { from, to } of edges) {
      if (!graph.has(from)) graph.set(from, []);
      graph.get(from)!.push(to);
    }

    const cycles: string[][] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const dfs = (node: string, stack: string[]) => {
      if (visiting.has(node)) {
        const idx = stack.indexOf(node);
        if (idx >= 0) cycles.push(stack.slice(idx));
        return;
      }
      if (visited.has(node)) return;
      visiting.add(node);
      stack.push(node);
      const next = graph.get(node) ?? [];
      for (const neighbor of next) {
        dfs(neighbor, stack);
      }
      stack.pop();
      visiting.delete(node);
      visited.add(node);
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) dfs(node, []);
    }

    if (cycles.length > 0) {
      insights.push({
        type: 'dependency',
        severity: 'medium',
        observation: `${cycles.length} circular dependencies detected.`,
        implication: 'Cyclic dependencies increase refactoring complexity and risk.',
        actionSuggestion: 'Use understand pillar to analyze module boundaries.',
        affectedFiles: Array.from(new Set(cycles.flat())),
        confidence: 0.9
      });
    }
  }

  private extractDependencyEdges(deps: any): Array<{ from: string; to: string }> {
    const edges: Array<{ from: string; to: string }> = [];
    const list = deps?.edges ?? deps?.links ?? deps?.relationships ?? [];
    if (Array.isArray(list)) {
      for (const edge of list) {
        const from = edge?.from ?? edge?.source;
        const to = edge?.to ?? edge?.target;
        if (from && to) edges.push({ from, to });
      }
    }
    return edges;
  }

  private detectImpactRisks(previews: any[], insights: Insight[]): void {
    const high = previews.filter(p => p?.riskLevel === 'high');
    const medium = previews.filter(p => p?.riskLevel === 'medium');
    if (high.length === 0 && medium.length === 0) return;

    const level = high.length > 0 ? 'high' : 'medium';
    const sample = (high.length > 0 ? high : medium)[0];
    const affectedFiles = Array.from(new Set(previews.flatMap(p => p?.summary?.impactedFiles ?? []).filter(Boolean)));

    insights.push({
      type: 'risk',
      severity: level,
      observation: `Impact analysis indicates ${level} risk for upcoming changes.`,
      implication: 'Changes may affect multiple dependent modules.',
      risk: 'Regression risk increases with blast radius.',
      actionSuggestion: 'Run suggested tests and review suggested files before applying changes.',
      affectedFiles,
      confidence: 0.85
    });
  }

  private computePageRankFromCalls(calls: any): Map<string, number> | undefined {
    const edges = this.extractDependencyEdges(calls);
    if (edges.length === 0) return undefined;

    const nodes = new Set<string>();
    for (const edge of edges) {
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
    const ids = Array.from(nodes);
    const n = ids.length;
    if (n === 0) return undefined;

    const outgoing = new Map<string, string[]>();
    for (const id of ids) outgoing.set(id, []);
    for (const edge of edges) {
      outgoing.get(edge.from)!.push(edge.to);
    }

    const damping = 0.85;
    let ranks = new Map<string, number>(ids.map(id => [id, 1 / n]));
    for (let iter = 0; iter < 15; iter++) {
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

  private buildPageRankSummary(pageRank?: Map<string, number>): SynthesizedInsights["pageRankSummary"] {
    if (!pageRank || pageRank.size === 0) return undefined;
    const entries = Array.from(pageRank.entries()).sort((a, b) => b[1] - a[1]);
    const topNodes = entries.slice(0, 5).map(([id, score]) => ({ id, score }));
    return {
      coverage: pageRank.size,
      topNodes
    };
  }

  private buildHotSpotSummary(hotSpots: any[]): SynthesizedInsights["hotSpotSummary"] {
    if (!hotSpots || hotSpots.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const spot of hotSpots) {
      const filePath = spot?.filePath;
      if (!filePath) continue;
      counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
    }
    const topFiles = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([filePath, count]) => ({ filePath, count }));
    return {
      count: hotSpots.length,
      topFiles
    };
  }

  private buildImpactSummary(previews: any[]): SynthesizedInsights["impactSummary"] {
    if (!previews || previews.length === 0) return undefined;
    const riskCounts = { high: 0, medium: 0, low: 0 };
    const impacted = new Set<string>();
    for (const preview of previews) {
      const level = preview?.riskLevel;
      if (level === "high") riskCounts.high += 1;
      else if (level === "medium") riskCounts.medium += 1;
      else riskCounts.low += 1;
      for (const file of preview?.summary?.impactedFiles ?? []) {
        impacted.add(file);
      }
    }
    return {
      riskCounts,
      impactedFiles: Array.from(impacted)
    };
  }

  private countSymbols(skeletons: any[]): number {
    return skeletons.reduce((acc, s) => {
      if (Array.isArray(s?.symbols)) return acc + s.symbols.length;
      if (Array.isArray(s?.metadata?.symbols)) return acc + s.metadata.symbols.length;
      return acc;
    }, 0);
  }

      private generateMermaid(data: any): string {
    if (!data.dependencies && !data.calls) return 'graph TD\\n  NoData[No analysis data available]';

    let mermaid = 'graph TD\\n';
    
    if (data.calls && data.calls.nodes) {
      data.calls.nodes.slice(0, 10).forEach((n: any) => {
        const label = n.label || n.id;
        mermaid += `  ${this.sanitizeId(n.id)}["${label}"]\\n`;
      });
      data.calls.edges.slice(0, 15).forEach((e: any) => {
        mermaid += `  ${this.sanitizeId(e.source)} --> ${this.sanitizeId(e.target)}\\n`;
      });
    }

    return mermaid;
  }

  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9]/g, '_');
  }


}
