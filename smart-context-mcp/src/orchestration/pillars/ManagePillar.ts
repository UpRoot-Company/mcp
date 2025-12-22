
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class ManagePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { action, targets, constraints } = intent;
    const target = targets[0];
    const scope = constraints.scope;
    const execute = async (command: string) => {
      const started = Date.now();
      const output = await this.registry.execute('manage_project', { command, target, scope });
      context.addStep({
        id: `${command}_${context.getFullHistory().length + 1}`,
        tool: 'manage_project',
        args: { command, target, scope },
        output,
        status: output?.success === false || output?.isError ? 'failure' : 'success',
        duration: Date.now() - started
      });
      return output;
    };
    
    switch (action) {
      case 'undo':
        return this.wrapResponse(await execute('undo'));
      case 'redo':
        return this.wrapResponse(await execute('redo'));
      case 'status':
        return this.wrapResponse(await execute('status'));
      case 'rebuild':
        return this.wrapResponse(await execute('reindex'));
      case 'history':
        return this.wrapResponse(await execute('history'));
      case 'test':
        return this.wrapResponse(await execute('test'));
      default:
        // Check intent directly if action mapping is imprecise
        if (intent.originalIntent.includes('undo')) return this.wrapResponse(await execute('undo'));
        if (intent.originalIntent.includes('redo')) return this.wrapResponse(await execute('redo'));
        if (intent.originalIntent.includes('rebuild') || intent.originalIntent.includes('reindex')) {
          return this.wrapResponse(await execute('reindex'));
        }
        if (intent.originalIntent.includes('history')) {
          return this.wrapResponse(await execute('history'));
        }
        if (intent.originalIntent.includes('test')) {
          return this.wrapResponse(await execute('test'));
        }
        return this.wrapResponse(await execute('status'));
    }
  }

  private wrapResponse(raw: any) {
    const indexStatus = raw?.status?.status ?? raw?.status ?? undefined;
    const projectState = indexStatus ? { indexStatus, pendingTransactions: raw?.history?.pendingTransactions?.length ?? 0, lastModified: new Date().toISOString() } : undefined;
    return {
      success: raw?.success ?? false,
      result: raw,
      projectState
    };
  }
}


