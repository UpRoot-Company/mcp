import * as ts from 'typescript';
import { AstBackend, AstDocument } from './AstBackend.js';

type SupportedExtension = '.ts' | '.tsx' | '.js' | '.jsx' | '.mjs' | '.cjs';

const EXT_TO_SCRIPT_KIND: Record<SupportedExtension, ts.ScriptKind> = {
    '.ts': ts.ScriptKind.TS,
    '.tsx': ts.ScriptKind.TSX,
    '.js': ts.ScriptKind.JS,
    '.jsx': ts.ScriptKind.JSX,
    '.mjs': ts.ScriptKind.JS,
    '.cjs': ts.ScriptKind.JS
};

export class JsAstBackend implements AstBackend {
    name = 'ts-compiler';
    capabilities = {
        supportsComments: false,
        supportsTypeAnnotations: true,
        supportsQueries: false,
        nodeTypeNormalization: 'native' as const
    };

    async initialize(): Promise<void> {
        // no-op: the TS compiler API does not require async setup
        return;
    }

    async parseFile(absPath: string, content: string, languageHint?: string): Promise<AstDocument> {
        const extension = (absPath.match(/\.[^.]+$/)?.[0] ?? '.ts').toLowerCase() as SupportedExtension;
        const scriptKind = EXT_TO_SCRIPT_KIND[extension] ?? ts.ScriptKind.TS;
        const source = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true, scriptKind);

        return {
            rootNode: source,
            languageId: languageHint || extension.replace('.', ''),
            dispose: () => { /* no resources */ }
        };
    }

    async getLanguage(languageId: string): Promise<any> {
        return { name: languageId, backend: this.name };
    }

    async getParser(languageId: string): Promise<any> {
        // The TS compiler API exposes createSourceFile directly, so we just return a helper
        return {
            parse: (code: string, filePath: string) => {
                const extension = (filePath.match(/\.[^.]+$/)?.[0] ?? '.ts').toLowerCase() as SupportedExtension;
                const scriptKind = EXT_TO_SCRIPT_KIND[extension] ?? ts.ScriptKind.TS;
                return ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKind);
            },
            languageId
        };
    }
}
