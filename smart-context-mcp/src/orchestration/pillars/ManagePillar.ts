
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
      case 'status':
        return await this.registry.execute('manage_project', { command: 'status' });
      default:
        // Check intent directly if action mapping is imprecise
        if (intent.originalIntent.includes('undo')) return await this.registry.execute('manage_project', { command: 'undo' });
        return await this.registry.execute('manage_project', { command: 'status' });
    }
  }
}


