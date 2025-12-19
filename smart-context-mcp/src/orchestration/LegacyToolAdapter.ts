
import { ParsedIntent } from './IntentRouter.js';


/**
 * LegacyToolAdapter: 기존 40여 개 도구 호출을 6대 기둥(Pillar) 호출로 변환합니다.
 */
export class LegacyToolAdapter {
  /**
   * 레거시 도구 이름과 인자를 새로운 기둥 체계로 매핑합니다.
   */
  public adapt(toolName: string, args: any): { category: string; args: any } | null {
    const mappings: Record<string, (a: any) => { category: string; args: any }> = {
      'read_code': (a) => ({
        category: 'read',
        args: { target: a.filePath, view: a.view || 'skeleton', lineRange: a.lineRange }
      }),
      'search_project': (a) => ({
        category: 'navigate',
        args: { target: a.query, limit: a.maxResults }
      }),
      'analyze_relationship': (a) => ({
        category: 'understand',
        args: { goal: `Analyze ${a.mode} of ${a.target}`, depth: a.maxDepth > 3 ? 'deep' : 'standard' }
      }),
      'edit_code': (a) => ({
        category: 'change',
        args: { intent: 'Apply specific edits', targetFiles: [a.filePath], edits: a.edits, options: { dryRun: a.dryRun } }
      }),
      'list_directory': (a) => ({
        category: 'navigate',
        args: { target: a.path }
      }),
      'manage_project': (a) => ({
        category: 'manage',
        args: { command: a.command, target: a.target }
      })
    };

    const mapper = mappings[toolName];
    return mapper ? mapper(args) : null;
  }
}
