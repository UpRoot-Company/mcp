
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
      'read_file': (a) => ({
        category: 'read',
        args: { target: a.filePath, view: a.full ? 'full' : 'skeleton', includeProfile: true }
      }),
      'read_fragment': (a) => ({
        category: 'read',
        args: { target: a.filePath, view: 'fragment', lineRange: a.lineRange }
      }),
      'search_project': (a) => ({
        category: 'navigate',
        args: { target: a.query, limit: a.maxResults }
      }),
      'search_files': (a) => ({
        category: 'navigate',
        args: { target: a.query || a.keywords?.join?.(' ') || a.patterns?.join?.(' ') || '' }
      }),
      'analyze_relationship': (a) => ({
        category: 'understand',
        args: {
          goal: `Analyze ${a.mode} of ${a.target}`,
          depth: a.maxDepth > 3 ? 'deep' : 'standard',
          include: {
            callGraph: a.mode === 'calls',
            dependencies: a.mode === 'dependencies'
          }
        }
      }),
      'edit_code': (a) => ({
        category: 'change',
        args: { intent: 'Apply specific edits', targetFiles: [a.filePath], edits: a.edits, options: { dryRun: a.dryRun } }
      }),
      'edit_file': (a) => ({
        category: 'change',
        args: { intent: 'Apply specific edits', targetFiles: [a.filePath], edits: a.edits, options: { dryRun: a.dryRun } }
      }),
      'write_file': (a) => ({
        category: 'write',
        args: { intent: 'Write file content', targetPath: a.filePath, content: a.content }
      }),
      'analyze_file': (a) => ({
        category: 'read',
        args: { target: a.filePath, view: 'skeleton', includeProfile: true }
      }),
      'list_directory': (a) => ({
        category: 'navigate',
        args: { target: a.path || a.target }
      }),
      'get_hierarchy': (a) => ({
        category: 'navigate',
        args: { target: a.path || a.target }
      }),
      'get_batch_guidance': (a) => ({
        category: 'change',
        args: { intent: 'Plan batch edits', targetFiles: a.filePaths, options: { dryRun: true, batchMode: true } }
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
