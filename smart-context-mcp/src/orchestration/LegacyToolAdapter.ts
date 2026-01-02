
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
        category: 'explore',
        args: (() => {
          const limits = a.view === 'fragment' ? { maxItemChars: 800 } : undefined;
          return {
            paths: [a.filePath],
            view: a.view === 'full' ? 'full' : 'preview',
            ...(limits ? { limits } : {})
          };
        })()
      }),
      'read_file': (a) => ({
        category: 'explore',
        args: { paths: [a.filePath], view: a.full ? 'full' : 'preview' }
      }),
      'read_fragment': (a) => ({
        category: 'explore',
        args: { paths: [a.filePath], view: 'preview', limits: { maxItemChars: 800 } }
      }),
      'search_project': (a) => ({
        category: 'explore',
        args: { query: a.query, limits: { maxResults: a.maxResults } }
      }),
      'search_files': (a) => ({
        category: 'explore',
        args: { query: a.query || a.keywords?.join?.(' ') || a.patterns?.join?.(' ') || '' }
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
        category: 'explore',
        args: { paths: [a.filePath], view: 'preview' }
      }),
      'list_directory': (a) => ({
        category: 'explore',
        args: { paths: [a.path || a.target], view: 'preview' }
      }),
      'get_hierarchy': (a) => ({
        category: 'explore',
        args: { paths: [a.path || a.target], view: 'preview' }
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
