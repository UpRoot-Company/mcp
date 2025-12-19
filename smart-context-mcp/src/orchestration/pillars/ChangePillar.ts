
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class ChangePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent, action } = intent;
    const { dryRun = true, includeImpact = true } = constraints;

    let targetPath = targets[0];

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

    // 2. Impact Analysis (Parallel)
    const impactPromise = includeImpact ? 
      this.registry.execute('analyze_relationship', { target: targetPath, mode: 'impact' }) : 
      Promise.resolve(null);

    // 3. Execute Edit (Includes DryRun)
    const editResult = await this.registry.execute('edit_code', {
      filePath: targetPath,
      edits: constraints.edits || [],
      dryRun: dryRun
    });

    const impact = await impactPromise;

    return {
      success: editResult.success,
      operation: dryRun ? 'plan' : 'apply',
      targetFile: targetPath,
      diff: editResult.diff,
      impactReport: impact,
      guidance: {
        message: dryRun ? 'Change plan generated. Review the diff before applying.' : 'Changes successfully applied.',
        suggestedActions: dryRun ? 
          [{ pillar: 'change', action: 'apply', intent: originalIntent, options: { dryRun: false, edits: constraints.edits } }] : 
          [{ pillar: 'manage', action: 'test' }]
      }
    };


  }
}
