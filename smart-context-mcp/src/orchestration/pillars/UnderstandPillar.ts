
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class UnderstandPillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent } = intent;
    const subject = targets[0] || originalIntent;
    const depth = constraints.depth || 'standard';
    const include = constraints.include ?? {};
    const includeDependencies = include.dependencies !== false || include.pageRank === true;
    const includeCalls = include.callGraph !== false;

    // 1. 초기 검색 수행
    const searchResult = await this.runTool(context, 'search_project', { 
      query: subject, 
      type: constraints.scope === 'project' ? 'file' : 'symbol',
      maxResults: 5
    });


        if (!searchResult.results || searchResult.results.length === 0) {
      return { summary: 'No relevant code found.', results: [] };
    }

    const primaryResult = searchResult.results[0];
    const filePath = primaryResult.path;

        // 2. Parallel Deep Data Collection (Eager Loading)
    const [skeleton, calls, deps, hotSpots, profile] = await Promise.all([
      this.runTool(context, 'read_code', { filePath, view: 'skeleton' }),
      includeCalls ?
        this.runTool(context, 'analyze_relationship', { 
          target: filePath, 
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
      include.hotSpots !== false
        ? this.runTool(context, 'hotspot_detector', {})
        : Promise.resolve([]),
      this.runTool(context, 'file_profiler', { filePath })
    ]);


        // 3. Synthesize Response (Advanced synthesis in Phase 3)
    return {
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
        message: 'Code structure analyzed. Use the "change" pillar if you need to modify it.',
        suggestedActions: [
          { pillar: 'read', action: 'view_full', target: filePath }
        ]
      }
    };

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
