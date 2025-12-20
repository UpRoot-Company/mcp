
import crypto from 'crypto';
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';


export class ReadPillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent } = intent;
    const target = constraints.targetPath || targets[0] || originalIntent;
    const view = constraints.view ?? (constraints.depth === 'deep' ? 'full' : 'skeleton');
    const includeProfile = constraints.includeProfile !== false;
    const resolvedPath = await this.resolveTargetPath(target);
    const lineRange = this.normalizeLineRange(constraints.lineRange);

    const content = await this.registry.execute('read_code', {
      filePath: resolvedPath,
      view,
      lineRange
    });

    const [profile, skeleton, fullContent] = await Promise.all([
      includeProfile ? this.registry.execute('file_profiler', { filePath: resolvedPath }) : Promise.resolve(null),
      view === 'skeleton' ? Promise.resolve(content) : this.registry.execute('read_code', { filePath: resolvedPath, view: 'skeleton' }),
      view === 'full'
        ? Promise.resolve(content)
        : (includeProfile ? this.registry.execute('read_code', { filePath: resolvedPath, view: 'full' }) : Promise.resolve(null))
    ]);

    const hashSource = typeof fullContent === 'string' ? fullContent : content;
    const hash = this.computeHash(hashSource);
    const metadata = {
      filePath: profile?.metadata?.relativePath ?? profile?.metadata?.filePath ?? resolvedPath,
      hash,
      lineCount: profile?.metadata?.lineCount ?? (typeof fullContent === 'string' ? fullContent.split(/\r?\n/).length : 0),
      language: profile?.metadata?.language ?? null
    };

    return {
      content,
      metadata,
      profile: profile ?? undefined,
      skeleton: typeof skeleton === 'string' ? skeleton : undefined,
      guidance: {
        message: view === 'full' ? 'Full content loaded.' : 'Content loaded. Use view="full" for full content.',
        suggestedActions: view === 'full' ? [] : [{ pillar: 'read', action: 'view_full', target: resolvedPath }]
      }
    };
  }

  private async resolveTargetPath(target: string): Promise<string> {
    if (this.looksLikePath(target)) {
      return target;
    }
    const symbolMatch = await this.registry.execute('search_project', { query: target, type: 'symbol', maxResults: 1 });
    if (symbolMatch?.results?.length > 0) {
      return symbolMatch.results[0].path;
    }
    const fileMatch = await this.registry.execute('search_project', { query: target, type: 'file', maxResults: 1 });
    if (fileMatch?.results?.length > 0) {
      return fileMatch.results[0].path;
    }
    return target;
  }

  private looksLikePath(target: string): boolean {
    return /[\\/]/.test(target) || /\.[a-z0-9]+$/i.test(target);
  }

  private normalizeLineRange(raw?: string | [number, number]): string | undefined {
    if (!raw) return undefined;
    if (Array.isArray(raw) && raw.length === 2) {
      return `${raw[0]}-${raw[1]}`;
    }
    return raw;
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content ?? '').digest('hex');
  }
}

export class WritePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { constraints, targets, originalIntent } = intent;
    const targetPath = constraints.targetPath || targets[0];
    const content = constraints.content ?? '';

    if (!targetPath) {
      return {
        success: false,
        createdFiles: [],
        transactionId: null,
        guidance: {
          message: 'Missing targetPath. Provide a file path to create.',
          suggestedActions: []
        }
      };
    }

    let existingContent: string | null = null;
    try {
      existingContent = await this.registry.execute('read_code', { filePath: targetPath, view: 'full' });
    } catch {
      existingContent = null;
    }

    if (existingContent === null) {
      // Ensure file exists (creates directories if needed).
      try {
        await this.registry.execute('write_file', { filePath: targetPath, content: '' });
      } catch {
        await this.registry.execute('edit_code', {
          edits: [{ filePath: targetPath, operation: 'create', replacementString: '' }],
          dryRun: false,
          createMissingDirectories: true
        });
      }
    }

    if (content === '' && existingContent === null) {
      return {
        success: true,
        createdFiles: [{ path: targetPath, description: `Created from intent: ${originalIntent}` }],
        transactionId: null,
        guidance: {
          message: 'Empty file created.',
          suggestedActions: [{ pillar: 'read', action: 'view_full', target: targetPath }]
        }
      };
    }

    const edit = existingContent === null
      ? {
          targetString: '',
          replacementString: content,
          insertMode: 'at' as const,
          insertLineRange: { start: 1 }
        }
      : {
          targetString: existingContent,
          replacementString: content
        };

    const editResult = await this.registry.execute('edit_coordinator', {
      filePath: targetPath,
      edits: [edit],
      dryRun: false
    });

    return {
      success: editResult.success ?? true,
      createdFiles: [{ path: targetPath, description: `Written from intent: ${originalIntent}` }],
      transactionId: editResult.operation?.id ?? null,
      guidance: {
        message: editResult.success ? 'File written.' : 'File write failed.',
        suggestedActions: editResult.success ? [{ pillar: 'read', action: 'view_full', target: targetPath }] : []
      }
    };
  }
}

