
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class ChangePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent, action } = intent;
    const { dryRun = true, includeImpact = true } = constraints;

    let targetPath = targets[0];
    const rawEdits = Array.isArray(constraints.edits) ? constraints.edits : [];

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

    const edits = rawEdits.map((edit: any) => ({
      ...edit,
      filePath: edit.filePath || targetPath
    }));

    // 2. Impact Analysis (Parallel)
    const impactPromise = includeImpact ?
      this.registry.execute('impact_analyzer', { target: targetPath, edits }) :
      Promise.resolve(null);

    // 3. Execute Edit (Includes DryRun)
    const editResult = await this.registry.execute('edit_code', {
      edits,
      dryRun
    });

    let finalResult = editResult;
    let autoCorrected = false;

    if (!editResult.success && edits.length > 0) {
      const needsFallback = edits.some((edit: any) => !edit.fuzzyMode);
      if (needsFallback) {
        const correctedEdits = edits.map((edit: any) => ({
          ...edit,
          fuzzyMode: edit.fuzzyMode ?? 'whitespace'
        }));
        const correctedResult = await this.registry.execute('edit_code', {
          edits: correctedEdits,
          dryRun
        });
        if (correctedResult.success) {
          finalResult = correctedResult;
          autoCorrected = true;
        }
      }
    }

    const impact = await impactPromise;

    return {
      success: finalResult.success,
      operation: dryRun ? 'plan' : 'apply',
      targetFile: targetPath,
      diff: finalResult.diff,
      impactReport: impact,
      autoCorrected,
      guidance: {
        message: dryRun ? 'Change plan generated. Review the diff before applying.' : 'Changes successfully applied.',
        suggestedActions: dryRun ?
          [{ pillar: 'change', action: 'apply', intent: originalIntent, options: { dryRun: false, edits } }] :
          [{ pillar: 'manage', action: 'test' }]
      }
    };


  }
}
