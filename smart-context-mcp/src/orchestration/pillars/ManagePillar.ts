
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class ManagePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { action, targets } = intent;
    const target = targets[0];
    
    switch (action) {
      case 'undo':
        return await this.registry.execute('manage_project', { command: 'undo' });
      case 'redo':
        return await this.registry.execute('manage_project', { command: 'redo' });
      case 'status':
        return await this.registry.execute('manage_project', { command: 'status' });
      case 'rebuild':
        return await this.registry.execute('manage_project', { command: 'reindex' });
      case 'history':
        return await this.registry.execute('manage_project', { command: 'history' });
      case 'test':
        return await this.registry.execute('manage_project', { command: 'test', target });
      default:
        // Check intent directly if action mapping is imprecise
        if (intent.originalIntent.includes('undo')) return await this.registry.execute('manage_project', { command: 'undo' });
        if (intent.originalIntent.includes('redo')) return await this.registry.execute('manage_project', { command: 'redo' });
        if (intent.originalIntent.includes('rebuild') || intent.originalIntent.includes('reindex')) {
          return await this.registry.execute('manage_project', { command: 'reindex' });
        }
        if (intent.originalIntent.includes('history')) {
          return await this.registry.execute('manage_project', { command: 'history' });
        }
        if (intent.originalIntent.includes('test')) {
          return await this.registry.execute('manage_project', { command: 'test', target });
        }
        return await this.registry.execute('manage_project', { command: 'status' });
    }
  }
}


