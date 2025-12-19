
import { IntentCategory } from './IntentRouter.js';


export interface SuggestedAction {
  priority: 1 | 2 | 3;
  pillar: IntentCategory;
  action: string;
  description: string;
  rationale: string;
  toolCall: {
    tool: string;
    args: Record<string, unknown>;
  };
}

export interface GuidancePayload {
  message: string;          // Human-readable summary for the agent
  contextSummary: string;
  suggestedActions: SuggestedAction[];
  warnings: string[];
}

/**
 * GuidanceGenerator: Applies heuristic rules to guide the agent's next steps.
 */
export class GuidanceGenerator {
  public generate(context: {
    lastPillar: string;
    lastResult: any;
    insights: any[];
    error?: any;
  }): GuidancePayload {
    const suggestedActions: SuggestedAction[] = [];
    const warnings: string[] = [];
    let message = 'Operation completed successfully.';

    // Rule 1: Post-Understand -> Examine primary file
    if (context.lastPillar === 'understand' && context.lastResult.primaryFile) {
      message = `Codebase structure for "${context.lastResult.summary}" has been analyzed.`;
      suggestedActions.push({
        priority: 1,
        pillar: 'read',
        action: 'examine',
        description: `Deep dive into "${context.lastResult.primaryFile}"`,
        rationale: 'Reviewing the actual implementation is the best next step before making changes.',
        toolCall: {
          tool: 'read',
          args: { target: context.lastResult.primaryFile, view: 'fragment' }
        }
      });
    }

    // Rule 2: Post-Change (DryRun) -> Apply
    if (context.lastPillar === 'change' && context.lastResult.operation === 'plan') {
      message = 'Change plan generated and verified via DryRun.';
      suggestedActions.push({
        priority: 1,
        pillar: 'change',
        action: 'apply',
        description: 'Apply these changes to the codebase.',
        rationale: 'The changes have been verified and impact is identified.',
        toolCall: {
          tool: 'change',
          args: { intent: context.lastResult.intent, options: { dryRun: false } }
        }
      });
    }

    // Rule 3: Error Recovery
    if (context.error) {
      message = `Operation failed: ${context.error.message}`;
      suggestedActions.push({
        priority: 1,
        pillar: 'manage',
        action: 'status',
        description: 'Check project index status.',
        rationale: 'Failures are often caused by stale indices.',
        toolCall: { tool: 'manage', args: { command: 'status' } }
      });
    }

    // Rule 4: High Risk Warning Integration
    const highRisk = context.insights.find(i => i.severity === 'high');
    if (highRisk) {
      warnings.push(`CRITICAL: ${highRisk.observation}`);
      message = 'High architectural risk detected. Proceed with caution.';
    }

    return {
      message,
      contextSummary: `Context: ${context.lastPillar}`,
      suggestedActions: suggestedActions.sort((a, b) => a.priority - b.priority).slice(0, 3),
      warnings
    };
  }
}

