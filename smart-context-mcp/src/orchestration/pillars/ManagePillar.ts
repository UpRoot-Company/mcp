
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class ManagePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { action } = intent;
    
    switch (action) {
      case 'undo':
        return await this.registry.execute('manage_project', { command: 'undo' });
      case 'redo':
        return await this.registry.execute('manage_project', { command: 'redo' });
      case 'status':
        return await this.registry.execute('manage_project', { command: 'status' });
      case 'rebuild':
        return await this.registry.execute('manage_project', { command: 'reindex' });
      default:
        // Check intent directly if action mapping is imprecise
        if (intent.originalIntent.includes('undo')) return await this.registry.execute('manage_project', { command: 'undo' });
        if (intent.originalIntent.includes('redo')) return await this.registry.execute('manage_project', { command: 'redo' });
        if (intent.originalIntent.includes('rebuild') || intent.originalIntent.includes('reindex')) {
          return await this.registry.execute('manage_project', { command: 'reindex' });
        }
        if (intent.originalIntent.includes('history')) {
          return { success: false, output: 'History view is not yet supported via manage pillar.' };
        }
        if (intent.originalIntent.includes('test')) {
          return { success: false, output: 'Test command is not available in manage pillar.' };
        }
        return await this.registry.execute('manage_project', { command: 'status' });
    }
  }
}


