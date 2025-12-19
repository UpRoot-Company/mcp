
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
  }): SynthesizedInsights {
    const insights: Insight[] = [];

    // 1. God Class/Module Detection (High Centrality)
    if (data.pageRank) {
      this.detectGodModules(data.pageRank, insights);
    }

    // 2. High Blast Radius Detection (Complex Dependencies)
    if (data.dependencies) {
      this.detectHighImpactAreas(data.dependencies, insights);
    }

    // 3. HotSpot Concentration (Maintenance Risk)
    if (data.hotSpots) {
      this.detectMaintenanceRisks(data.hotSpots, insights);
    }

    return {
      overview: {
        filesAnalyzed: data.skeletons.length,
        symbolsDiscovered: this.countSymbols(data.skeletons),
        generatedAt: new Date().toISOString()
      },
      insights,
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

  private countSymbols(skeletons: any[]): number {
    return skeletons.reduce((acc, s) => acc + (s.metadata?.symbols?.length || 0), 0);
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
