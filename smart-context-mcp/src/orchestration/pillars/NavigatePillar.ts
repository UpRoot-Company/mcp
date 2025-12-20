
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class NavigatePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent } = intent;
    const target = targets[0] || originalIntent;
    const limit = constraints.limit || 10;
    
    const results = await this.registry.execute('search_project', {
      query: target,
      maxResults: limit
    });


    // Eager Loading: 단일 결과인 경우 Smart File Profile 추가
    if (results.results && results.results.length === 1) {
      const primary = results.results[0];
      const profile = await this.registry.execute('file_profiler', { filePath: primary.path });
      return {
        ...results,
        codePreview: primary.context || undefined,
        smartProfile: profile
      };
    }

    return results;
  }
}
