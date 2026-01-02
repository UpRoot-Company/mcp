
import crypto from 'crypto';
import path from 'path';
import { InternalToolRegistry } from '../InternalToolRegistry.js';
import { OrchestrationContext } from '../OrchestrationContext.js';
import { ParsedIntent } from '../IntentRouter.js';
import { metrics } from '../../utils/MetricsCollector.js';


export class ReadPillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const { targets, constraints, originalIntent } = intent;
    const target = constraints.targetPath || targets[0] || originalIntent;
    const view = constraints.view ?? (constraints.depth === 'deep' ? 'full' : 'skeleton');
    const includeProfile = constraints.includeProfile === true;
    const includeHash = constraints.includeHash === true;
    const resolvedPath = await this.resolveTargetPath(target);
    const lineRange = this.normalizeLineRange(constraints.lineRange);
    const sectionId = constraints.sectionId;
    const headingPath = constraints.headingPath;
    const isDocument = this.isDocumentPath(resolvedPath);

    let content: string;
    let documentOutline: any = undefined;

    if (isDocument && (sectionId || headingPath)) {
      const mode = (constraints.mode ?? (view === 'full' ? 'raw' : 'preview')) as 'summary' | 'preview' | 'raw';
      const maxChars = typeof constraints.maxChars === 'number'
        ? constraints.maxChars
        : Number.parseInt(process.env.SMART_CONTEXT_DOC_SECTION_MAX_CHARS ?? (mode === 'raw' ? '12000' : '4000'), 10);
      const docSection = await this.runTool(context, 'doc_section', {
        filePath: resolvedPath,
        sectionId,
        headingPath,
        includeSubsections: constraints.includeSubsections === true,
        mode,
        maxChars
      });
      content = docSection?.content ?? '';
      documentOutline = docSection?.section ? [docSection.section] : undefined;
    } else if (isDocument && view === 'skeleton') {
      const docSkeleton = await this.runTool(context, 'doc_skeleton', {
        filePath: resolvedPath,
        options: constraints.outlineOptions
      });
      const maxChars = Number.parseInt(process.env.SMART_CONTEXT_DOC_SKELETON_MAX_CHARS ?? "2000", 10);
      content = truncateText(docSkeleton?.skeleton ?? '', maxChars);
      documentOutline = docSkeleton?.outline;
    } else {
      content = await this.runTool(context, 'read_code', {
        filePath: resolvedPath,
        view,
        lineRange
      });
    }

    const needsFullContent = view === 'full' || includeHash;
    const includeSkeleton = view === 'skeleton';

    const [profile, skeleton, fullContent] = await Promise.all([
      this.runTool(context, 'file_profiler', { filePath: resolvedPath }),
      includeSkeleton ? Promise.resolve(content) : Promise.resolve(null),
      needsFullContent
        ? (view === 'full' ? Promise.resolve(content) : this.runTool(context, 'read_code', { filePath: resolvedPath, view: 'full' }))
        : Promise.resolve(null)
    ]);

    const hashSource = typeof fullContent === 'string' ? fullContent : content;
    const hash = includeHash ? this.computeHash(hashSource) : '';
    const metadata = {
      filePath: profile?.metadata?.relativePath ?? profile?.metadata?.filePath ?? resolvedPath,
      hash,
      lineCount: profile?.metadata?.lineCount ?? (typeof fullContent === 'string' ? fullContent.split(/\r?\n/).length : (typeof content === 'string' ? content.split(/\r?\n/).length : 0)),
      language: profile?.metadata?.language ?? null
    };

    return {
      success: true,
      status: 'success',
      content,
      metadata,
      profile: includeProfile ? (profile ?? undefined) : undefined,
      skeleton: typeof skeleton === 'string' ? skeleton : undefined,
      document: documentOutline ? { outline: documentOutline } : undefined,
      guidance: {
        message: view === 'full'
          ? 'Full content loaded.'
          : 'Content loaded. Use view="full" or includeProfile/includeHash for more detail.',
        suggestedActions: view === 'full'
          ? []
          : [
              { pillar: 'read', action: 'view_full', target: resolvedPath },
              { pillar: 'read', action: 'include_profile', target: resolvedPath, options: { includeProfile: true } }
            ]
      }
    };
  }

  private async resolveTargetPath(target: string): Promise<string> {
    if (this.looksLikePath(target)) {
      if (!/[\\/]/.test(target)) {
        const filenameMatch = await this.registry.execute('search_project', { query: target, type: 'filename', maxResults: 1 });
        if (filenameMatch?.results?.length > 0) {
          return filenameMatch.results[0].path;
        }
      }
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

  private isDocumentPath(target: string): boolean {
    return /\.(md|mdx|txt|log|docx|xlsx|pdf)$/i.test(target);
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

  private async runTool(context: OrchestrationContext, tool: string, args: any) {
    const started = Date.now();
    const output = await this.registry.execute(tool, args);
    context.addStep({
      id: `${tool}_${context.getFullHistory().length + 1}`,
      tool,
      args,
      output,
      status: output?.success === false || output?.isError ? 'failure' : 'success',
      duration: Date.now() - started
    });
    return output;
  }
}

function truncateText(text: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 2000;
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1))}…`;
}

export class WritePillar {
  constructor(private readonly registry: InternalToolRegistry) {}

  private computeHash(content: string): { algorithm: 'xxhash' | 'sha256'; value: string } {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { algorithm: 'sha256', value: hash };
  }


  public async execute(intent: ParsedIntent, context: OrchestrationContext): Promise<any> {
    const stopTotal = metrics.startTimer("write.total_ms");
    try {
      const { constraints, targets, originalIntent } = intent;
      const targetPath = constraints.targetPath || targets[0];
      const template = constraints.template;
      let content = constraints.content ?? '';
      const hasExplicitContent = constraints.content !== undefined;
      const safeWrite = Boolean((constraints as any).safeWrite);

      if (!targetPath) {
        return {
          success: false,
          status: 'failure',
          createdFiles: [],
          transactionId: null,
          guidance: {
            message: 'Missing targetPath. Provide a file path to create.',
            suggestedActions: []
          }
        };
      }

      const resolvedPath = await this.resolveTargetPath(targetPath);

      // ADR-042-005: Phase B3 - safeWrite mode (full range patch with undo support)
      if (hasExplicitContent && safeWrite) {
        const stopSafePatch = metrics.startTimer("write.safe_patch_ms");
        
        try {
          let existingContent = '';
          try {
            existingContent = await this.runTool(context, 'read_code', { 
              filePath: resolvedPath, 
              view: 'full' 
            });
          } catch {
            // File doesn't exist - create empty first
            try {
              await this.runTool(context, 'write_file', { filePath: resolvedPath, content: '' });
            } catch {
              await this.runTool(context, 'edit_code', {
                edits: [{ filePath: resolvedPath, operation: 'create', replacementString: '' }],
                dryRun: false,
                createMissingDirectories: true
              });
            }
            existingContent = '';
          }

          // Convert to full range edit (using edit_coordinator)
          const edit = {
            targetString: existingContent,
            replacementString: content,
            indexRange: { start: 0, end: existingContent.length },
            expectedHash: existingContent ? this.computeHash(existingContent) : undefined
          };

          const result = await this.runTool(context, 'edit_coordinator', {
            filePath: resolvedPath,
            edits: [edit],
            dryRun: false
          });

          stopSafePatch();

          return {
            success: result.success ?? true,
            status: result.success === false ? 'failure' : 'success',
            createdFiles: result.success ? [{ 
              path: resolvedPath, 
              description: `Written (safe mode) from intent: ${originalIntent}` 
            }] : [],
            transactionId: result.operation?.id || '',
            rollbackAvailable: true,
            writeMode: 'safe',
            guidance: {
              message: result.success 
                ? 'File written with undo support.' 
                : `Write failed: ${result.message || 'Unknown error'}`,
              suggestedActions: result.success 
                ? [{ pillar: 'read', action: 'view_full', target: resolvedPath }] 
                : []
            }
          };
        } catch (error: any) {
          stopSafePatch();
          return {
            success: false,
            status: 'failure',
            createdFiles: [],
            transactionId: '',
            rollbackAvailable: false,
            writeMode: 'safe',
            guidance: {
              message: `Safe write failed: ${error.message}`,
              suggestedActions: []
            }
          };
        }
      }

      if (hasExplicitContent && !safeWrite) {
        try {
          await this.runTool(context, 'write_file', { filePath: resolvedPath, content });
        } catch {
          await this.runTool(context, 'edit_code', {
            edits: [{ filePath: resolvedPath, operation: 'create', replacementString: content }],
            dryRun: false,
            createMissingDirectories: true
          });
        }

        return {
          success: true,
          status: 'success',
          createdFiles: [{ path: resolvedPath, description: `Written from intent: ${originalIntent}` }],
          transactionId: '',
          rollbackAvailable: false,
          writeMode: 'fast',
          guidance: {
            message: 'File written (fast mode, no undo).',
            suggestedActions: [{ pillar: 'read', action: 'view_full', target: resolvedPath }]
          }
        };
      }

      let existingContent: string | null = null;
      try {
        existingContent = await this.runTool(context, 'read_code', { filePath: resolvedPath, view: 'full' });
      } catch {
        existingContent = null;
      }

      if (existingContent === null) {
        // Ensure file exists (creates directories if needed).
        try {
          await this.runTool(context, 'write_file', { filePath: resolvedPath, content: '' });
        } catch {
          await this.runTool(context, 'edit_code', {
            edits: [{ filePath: resolvedPath, operation: 'create', replacementString: '' }],
            dryRun: false,
            createMissingDirectories: true
          });
        }
      }

      if (content === '' && template) {
        const templated = await this.resolveTemplateContent(template, resolvedPath, originalIntent, context);
        if (typeof templated === 'string') {
          content = templated;
        }
      }

      if (content === '' && existingContent === null) {
        return {
          success: true,
          status: 'success',
          createdFiles: [{ path: resolvedPath, description: `Created from intent: ${originalIntent}` }],
          transactionId: null,
          guidance: {
            message: 'Empty file created.',
            suggestedActions: [{ pillar: 'read', action: 'view_full', target: resolvedPath }]
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

      const editResult = await this.runTool(context, 'edit_coordinator', {
        filePath: resolvedPath,
        edits: [edit],
        dryRun: false
      });

      return {
        success: editResult.success ?? true,
        status: editResult.success === false ? 'failure' : 'success',
        createdFiles: [{ path: resolvedPath, description: `Written from intent: ${originalIntent}` }],
        transactionId: editResult.operation?.id ?? '',
        guidance: {
          message: editResult.success ? 'File written.' : 'File write failed.',
          suggestedActions: editResult.success ? [{ pillar: 'read', action: 'view_full', target: resolvedPath }] : []
        }
      };
    } finally {
      stopTotal();
    }
  }

  private async resolveTargetPath(targetPath: string): Promise<string> {
    if (!this.looksLikePath(targetPath)) {
      return targetPath;
    }
    if (!/[\\/]/.test(targetPath)) {
      const filenameMatch = await this.registry.execute('search_project', { query: targetPath, type: 'filename', maxResults: 1 });
      if (filenameMatch?.results?.length > 0) {
        return filenameMatch.results[0].path;
      }
    }
    return targetPath;
  }

  private async resolveTemplateContent(
    template: string,
    targetPath: string,
    intent: string,
    context: OrchestrationContext
  ): Promise<string | null> {
    const trimmed = template.trim();
    if (!trimmed) return null;

    if (this.looksLikePath(trimmed)) {
      try {
        const raw = await this.runTool(context, 'read_code', { filePath: trimmed, view: 'full' });
        if (typeof raw === 'string' && raw.length > 0) {
          return raw;
        }
      } catch {
        // fall through to built-in templates
      }
    }

    const normalized = trimmed.toLowerCase();
    const ext = path.extname(targetPath).toLowerCase();
    const baseName = path.basename(targetPath, ext);
    const className = this.toPascalCase(baseName || 'Generated');

    if (normalized.includes('test') || normalized.includes('jest') || normalized.includes('spec')) {
      if (ext === '.ts' || ext === '.tsx') {
        return `import { describe, it, expect } from "@jest/globals";\n\n` +
          `describe("${className}", () => {\n  it("todo", () => {\n    expect(true).toBe(true);\n  });\n});\n`;
      }
      if (ext === '.js' || ext === '.jsx') {
        return `describe("${className}", () => {\n  it("todo", () => {\n    expect(true).toBe(true);\n  });\n});\n`;
      }
    }

    if (normalized.includes('class') || normalized.includes('service') || normalized.includes('module')) {
      if (ext === '.ts' || ext === '.tsx') {
        return `export class ${className} {\n  constructor() {}\n}\n`;
      }
      if (ext === '.js' || ext === '.jsx') {
        return `class ${className} {\n  constructor() {}\n}\n\nmodule.exports = { ${className} };\n`;
      }
    }

    if (normalized.includes('readme') || ext === '.md') {
      return `# ${className}\n\n${intent}\n`;
    }

    return `// Template: ${template}\n`;
  }

  private looksLikePath(value: string): boolean {
    return /[\\/]/.test(value) || /\.[a-z0-9]+$/i.test(value);
  }

  private toPascalCase(value: string): string {
    return value
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }

  private async runTool(context: OrchestrationContext, tool: string, args: any) {
    const started = Date.now();
    const output = await this.registry.execute(tool, args);
    context.addStep({
      id: `${tool}_${context.getFullHistory().length + 1}`,
      tool,
      args,
      output,
      status: output?.success === false || output?.isError ? 'failure' : 'success',
      duration: Date.now() - started
    });
    return output;
  }
}

