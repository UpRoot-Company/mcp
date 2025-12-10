import { AstManager } from './AstManager.js';
import { SymbolInfo, ImportSymbol, ExportSymbol, DefinitionSymbol, CallSiteInfo, CallType } from '../types.js';

import { Query } from 'web-tree-sitter';

interface FoldQuery {
    query: string;
    shouldFold?: (node: any) => boolean;
    replacement?: string;
}

const LANGUAGE_CONFIG: Record<string, FoldQuery> = {
    typescript: {
        query: `
            (statement_block) @fold
        `,
        replacement: '{ /* ... implementation hidden ... */ }'
    },
    tsx: {
        query: `
            (statement_block) @fold
        `,
        replacement: '{ /* ... implementation hidden ... */ }'
    },
    javascript: {
        query: `
            (statement_block) @fold
        `,
        replacement: '{ /* ... implementation hidden ... */ }'
    },
    python: {
        query: `
            (block) @fold
        `,
        replacement: '... # implementation hidden',
        shouldFold: (node: any) => {
            if (node.parent && node.parent.type === 'class_definition') {
                return false;
            }
            return true;
        }
    },
};

export class SkeletonGenerator {
    private astManager: AstManager;
    private queryCache = new Map<string, any>(); 
    private extractionQueryCache = new Map<string, Query>(); 
    private callQueryCache = new Map<string, Query>();

    constructor() {
        this.astManager = AstManager.getInstance();
    }

    public async getParserForFile(filePath: string) {
        return this.astManager.getParserForFile(filePath);
    }

    public async getLanguageForFile(filePath: string) {
        return this.astManager.getLanguageForFile(filePath);
    }

    public async generateSkeleton(filePath: string, content: string): Promise<string> {
        if (typeof content !== 'string') return '';

        if (!this.astManager.supportsQueries()) {
            return content;
        }

        let doc;
        try {
            doc = await this.astManager.parseFile(filePath, content);
        } catch (e) {
            return content;
        }

        const lang = await this.astManager.getLanguageForFile(filePath);
        const langId = this.astManager.getLanguageId(filePath);
        const config = this.getLanguageConfig(filePath);
        if (!config) return content;

        let rootNode: any | null = null;
        try {
            rootNode = doc.rootNode;

            const maybeHasError = rootNode?.hasError;
            const rootHasError = typeof maybeHasError === 'function'
                ? maybeHasError.call(rootNode)
                : Boolean(maybeHasError);

            if (rootHasError) {
                throw new Error('Tree-sitter parse error detected while building skeleton');
            }
            const queryKey = `${langId}:${config.query}`; 
            let query = this.queryCache.get(queryKey);
            if (!query) {
                query = new Query(lang, config.query);
                this.queryCache.set(queryKey, query);
            }

            const matches = query.matches(rootNode);
            const rangesToFold: { start: number; end: number; }[] = [];

            for (const match of matches) {
                for (const capture of match.captures) {
                    if (capture.name === 'fold') {
                        const node = capture.node;
                        if (config.shouldFold && !config.shouldFold(node)) {
                            continue;
                        }
                        rangesToFold.push({
                            start: node.startIndex,
                            end: node.endIndex
                        });
                    }
                }
            }

            rangesToFold.sort((a, b) => a.start - b.start || b.end - a.end);

            const rootRanges: { start: number; end: number; }[] = [];
            let lastEnd = -1;

            for (const range of rangesToFold) {
                if (range.start >= lastEnd) {
                    rootRanges.push(range);
                    lastEnd = range.end;
                }
            }

            let skeleton = content;
            for (let i = rootRanges.length - 1; i >= 0; i--) {
                const range = rootRanges[i];
                const prefix = skeleton.substring(0, range.start);
                const suffix = skeleton.substring(range.end);
                skeleton = prefix + (config.replacement || '...') + suffix;
            }

            return skeleton;

        } catch (error) {
            throw error; 
        } finally {
            doc?.dispose?.();
        }
    }

    public async generateStructureJson(filePath: string, content: string): Promise<SymbolInfo[]> {
        if (typeof content !== 'string') return [];

        let doc;
        try {
            doc = await this.astManager.parseFile(filePath, content);
        } catch (e) {
            return [];
        }

        const lang = await this.astManager.getLanguageForFile(filePath);
        if (!lang || !this.astManager.supportsQueries()) return [];
        const langId = this.astManager.getLanguageId(filePath);

        let rootNode: any | null = null;
        const symbols: SymbolInfo[] = [];
        const definitionNodeMap = new Map<string, DefinitionSymbol>();

        try {
            rootNode = doc.rootNode;
            const queryKey = langId + '_EXTRACT';
            let query = this.extractionQueryCache.get(queryKey);

            if (!query) {
                let extractionQuerySource = '';
                if (langId === 'typescript' || langId === 'tsx' || langId === 'javascript') {
                    extractionQuerySource = `
                        (class_declaration name: (type_identifier) @name) @definition
                        (function_declaration name: (identifier) @name) @definition
                        (method_definition name: (property_identifier) @name) @definition
                        (interface_declaration name: (type_identifier) @name) @definition
                        (variable_declarator name: (identifier) @name) @definition
                        (import_statement) @import
                        (export_statement) @export
                    `;
                } else if (langId === 'python') {
                    extractionQuerySource = `
                        (class_definition name: (identifier) @name) @definition
                        (function_definition name: (identifier) @name) @definition
                        (import_statement) @import
                        (import_from_statement) @import
                    `;
                } else {
                    return []; 
                }
                query = new Query(lang, extractionQuerySource);
                this.extractionQueryCache.set(queryKey, query);
            }

            for (const match of query.matches(rootNode)) {
                for (const capture of match.captures) {
                    if (capture.name === 'definition') {
                        const nameCapture = match.captures.find((c: any) => c.name === 'name');
                        if (nameCapture) {
                            const symbol = this.processDefinition(capture.node, nameCapture.node, langId);
                            if (symbol) {
                                symbols.push(symbol);
                                definitionNodeMap.set(this.makeNodeKey(capture.node), symbol);
                            }
                        }
                    } else if (capture.name === 'import') {
                        const importSymbols = this.processImport(capture.node, langId);
                        symbols.push(...importSymbols);
                    } else if (capture.name === 'export') {
                        const exportSymbols = this.processExport(capture.node, langId);
                        symbols.push(...exportSymbols);
                    }
                }
            }

            if (definitionNodeMap.size > 0) {
                this.attachCallSiteMetadata(rootNode, lang, langId, definitionNodeMap);
            }

        } catch (error) {
            console.error(`Error generating JSON skeleton for ${filePath}:`, error);
            throw error; 
        } finally {
            doc?.dispose?.();
        }

        return symbols;
    }

    public async findIdentifiers(filePath: string, content: string, targetNames: string[]): Promise<{ name: string, range: any }[]> {
        if (typeof content !== 'string') return [];
        
        if (!this.astManager.supportsQueries()) {
            return [];
        }

        let doc;
        try {
            doc = await this.astManager.parseFile(filePath, content);
        } catch (e) {
            return [];
        }

        const lang = await this.astManager.getLanguageForFile(filePath);
        if (!lang) return [];

        let rootNode: any | null = null;
        const results: { name: string, range: any }[] = [];

        try {
            rootNode = doc.rootNode;
            const query = new Query(lang, `
                (identifier) @id
                (property_identifier) @id
                (type_identifier) @id
                (shorthand_property_identifier_pattern) @id
            `);
            const matches = query.matches(rootNode);
            
            const targetSet = new Set(targetNames);

            for (const match of matches) {
                const node = match.captures[0].node;
                if (targetSet.has(node.text)) {
                    results.push({
                        name: node.text,
                        range: {
                            startLine: node.startPosition.row,
                            endLine: node.endPosition.row,
                            startByte: node.startIndex,
                            endByte: node.endIndex
                        }
                    });
                }
            }
        } catch (error) {
            console.error(`Error finding identifiers in ${filePath}:`, error);
        } finally {
            doc?.dispose?.();
        }
        return results;
    }

    private attachCallSiteMetadata(rootNode: any, lang: any, langId: string, definitionNodeMap: Map<string, DefinitionSymbol>) {
        const query = this.getCallQuery(langId, lang);
        if (!query) return;

        const matches = query.matches(rootNode);
        for (const match of matches) {
            const parsed = this.parseCallMatch(match);
            if (!parsed) continue;
            const owner = this.findOwningDefinition(parsed.node, definitionNodeMap);
            if (!owner) continue;

            const callInfo: CallSiteInfo = {
                calleeName: parsed.calleeName,
                calleeObject: parsed.calleeObject,
                callType: parsed.callType,
                line: parsed.node.startPosition.row + 1,
                column: parsed.node.startPosition.column + 1,
                text: parsed.node.text
            };

            if (!owner.calls) {
                owner.calls = [];
            }
            owner.calls.push(callInfo);
        }
    }

    private getCallQuery(langId: string, lang: any): Query | null {
        const source = this.getCallQuerySource(langId);
        if (!source) return null;
        const cacheKey = `${langId}_CALLS`;
        let query = this.callQueryCache.get(cacheKey);
        if (!query) {
            query = new Query(lang, source);
            this.callQueryCache.set(cacheKey, query);
        }
        return query;
    }

    private getCallQuerySource(langId: string): string | null {
        if (langId === 'typescript' || langId === 'tsx' || langId === 'javascript') {
            return `
                (call_expression
                    function: (identifier) @call_direct_name) @call_direct

                (call_expression
                    function: (member_expression
                        object: (_) @call_method_object
                        property: (property_identifier) @call_method_name)) @call_method

                (new_expression
                    constructor: (identifier) @call_ctor_name) @call_ctor
            `;
        }

        if (langId === 'python') {
            return `
                (call
                    function: (identifier) @py_call_name) @py_call

                (call
                    function: (attribute
                        object: (_) @py_method_object
                        attribute: (identifier) @py_method_name)) @py_method
            `;
        }

        return null;
    }

    private parseCallMatch(match: any): { node: any; calleeName: string; calleeObject?: string; callType: CallType } | null {
        const getNode = (name: string) => match.captures.find((capture: any) => capture.name === name)?.node;

        const methodNode = getNode('call_method') || getNode('py_method');
        if (methodNode) {
            const nameNode = getNode('call_method_name') || getNode('py_method_name');
            if (!nameNode) return null;
            const objectNode = getNode('call_method_object') || getNode('py_method_object');
            return {
                node: methodNode,
                calleeName: nameNode.text,
                calleeObject: objectNode?.text,
                callType: 'method'
            };
        }

        const ctorNode = getNode('call_ctor');
        if (ctorNode) {
            const nameNode = getNode('call_ctor_name');
            if (!nameNode) return null;
            return {
                node: ctorNode,
                calleeName: nameNode.text,
                callType: 'constructor'
            };
        }

        const directNode = getNode('call_direct') || getNode('py_call');
        if (directNode) {
            const nameNode = getNode('call_direct_name') || getNode('py_call_name');
            if (!nameNode) return null;
            return {
                node: directNode,
                calleeName: nameNode.text,
                callType: 'direct'
            };
        }

        return null;
    }

    private findOwningDefinition(node: any, definitionNodeMap: Map<string, DefinitionSymbol>): DefinitionSymbol | undefined {
        let current = node;
        while (current) {
            const symbol = definitionNodeMap.get(this.makeNodeKey(current));
            if (symbol) {
                return symbol;
            }
            current = current.parent;
        }
        return undefined;
    }

    private makeNodeKey(node: any): string {
        const start = typeof node.startIndex === 'number' ? node.startIndex : 0;
        const end = typeof node.endIndex === 'number' ? node.endIndex : start;
        const idPart = typeof node.id === 'number' || typeof node.id === 'string'
            ? String(node.id)
            : '';
        return `${idPart}:${start}:${end}`;
    }

    private processDefinition(definitionNode: any, nameNode: any, langName: string): DefinitionSymbol | null {
        const resolvedType = this.resolveSymbolType(definitionNode);
        if (!resolvedType) return null;

        let containerName: string | undefined;
        let parent = definitionNode.parent;
        while (parent) {
            if (['class_declaration', 'interface_declaration', 'class_definition', 'function_declaration', 'method_definition'].includes(parent.type)) {
                const parentNameNode = parent.childForFieldName('name');
                if (parentNameNode) {
                    containerName = parentNameNode.text;
                    break;
                }
            }
            parent = parent.parent;
        }

        let signature = definitionNode.text.substring(nameNode.startIndex - definitionNode.startIndex);
        if (definitionNode.childForFieldName('body')) {
            const bodyNode = definitionNode.childForFieldName('body');
            if (bodyNode) {
                signature = definitionNode.text.substring(0, bodyNode.startIndex - definitionNode.startIndex).trim();
            }
        }

        const parameters = this.extractParameterNames(definitionNode);
        const returnType = this.extractReturnType(definitionNode);
        const doc = this.extractDocumentation(definitionNode, langName);
        
        const modifiers: string[] = [];
        let p = definitionNode.parent;
        if (p && (p.type === 'export_statement')) {
            modifiers.push('export');
            if (p.children.some((c: any) => c.type === 'default')) modifiers.push('default');
        }
        
        if (definitionNode.children) {
            for (const child of definitionNode.children) {
                if (child.type.includes('modifier') || child.type === 'static') {
                    modifiers.push(child.text);
                }
            }
        }

        return {
            type: resolvedType,
            name: nameNode.text,
            range: {
                startLine: definitionNode.startPosition.row,
                endLine: definitionNode.endPosition.row,
                startByte: definitionNode.startIndex,
                endByte: definitionNode.endIndex,
            },
            container: containerName,
            signature,
            parameters,
            returnType,
            modifiers,
            doc
        } as DefinitionSymbol;
    }

    private extractDocumentation(node: any, langName: string): string | undefined {
        if (langName === 'typescript' || langName === 'tsx' || langName === 'javascript') {
            const comments: string[] = [];
            let prev = node.previousSibling;
            let iterations = 0;
            const MAX_COMMENT_SCAN = 50;
            
            while (prev && iterations < MAX_COMMENT_SCAN) {
                iterations++;
                if (prev.type === 'comment') {
                    comments.unshift(prev.text);
                    prev = prev.previousSibling;
                } else if (prev.type.match(/\s/) || prev.text.trim() === '') { 
                    // Skip whitespace/newlines
                    prev = prev.previousSibling;
                } else {
                    break;
                }
            }
            return comments.length > 0 ? comments.join('\n') : undefined;
        } else if (langName === 'python') {
            const body = node.childForFieldName('body');
            if (body && body.firstChild) {
                const first = body.firstChild;
                if (first.type === 'expression_statement') {
                    const stringNode = first.firstChild;
                    if (stringNode && stringNode.type === 'string') {
                        const text = stringNode.text;
                        if (text.startsWith('"""') && text.endsWith('"""')) return text.slice(3, -3);
                        if (text.startsWith("'''") && text.endsWith("'''")) return text.slice(3, -3);
                        if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
                        if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
                        return text;
                    }
                }
            }
        }
        return undefined;
    }

    private processImport(node: any, langName: string): ImportSymbol[] {
        const results: ImportSymbol[] = [];
        if (langName === 'typescript' || langName === 'tsx' || langName === 'javascript') {
            const sourceNode = node.childForFieldName('source');
            if (!sourceNode) return [];
            const source = sourceNode.text.slice(1, -1); 

            const isTypeOnly = node.children.some((c: any) => c.type === 'type' || c.text === 'type');
            const importClause = node.children.find((c: any) => c.type === 'import_clause');
            if (importClause) {

                // 1. Default Import
                const defaultImport = importClause.children.find((c: any) => c.type === 'identifier');
                if (defaultImport) {
                    results.push({
                        type: 'import',
                        name: defaultImport.text,
                        source,
                        importKind: 'default',
                        alias: defaultImport.text,
                        isTypeOnly,
                        range: {
                            startLine: node.startPosition.row,
                            endLine: node.endPosition.row,
                            startByte: node.startIndex,
                            endByte: node.endIndex,
                        }
                    });
                }

                // 2. Named Imports
                const namedImports = importClause.children.find((c: any) => c.type === 'named_imports');
                if (namedImports) {
                     const importsList: { name: string; alias?: string }[] = [];
                     for (const child of namedImports.children) {
                         if (child.type === 'import_specifier') {
                             const nameNode = child.childForFieldName('name');
                             const aliasNode = child.childForFieldName('alias');
                             if (nameNode) {
                                 importsList.push({
                                     name: nameNode.text,
                                     alias: aliasNode ? aliasNode.text : undefined
                                 });
                             }
                         }
                     }
                     results.push({
                         type: 'import',
                         name: 'imports from ' + source, 
                         source,
                         importKind: 'named',
                         imports: importsList,
                         isTypeOnly,
                         range: {
                             startLine: node.startPosition.row,
                             endLine: node.endPosition.row,
                             startByte: node.startIndex,
                             endByte: node.endIndex,
                         }
                     });
                }
                
                // 3. Namespace Import
                const namespaceImport = importClause.children.find((c: any) => c.type === 'namespace_import');
                if (namespaceImport) {
                     const aliasNode = namespaceImport.children.find((c: any) => c.type === 'identifier');
                     if (aliasNode) {
                         results.push({
                            type: 'import',
                            name: aliasNode.text,
                            source,
                            importKind: 'namespace',
                            alias: aliasNode.text,
                            isTypeOnly,
                            range: {
                                startLine: node.startPosition.row,
                                endLine: node.endPosition.row,
                                startByte: node.startIndex,
                                endByte: node.endIndex,
                            }
                         });
                     }
                }
            } else {
                results.push({
                    type: 'import',
                    name: source,
                    source,
                    importKind: 'side-effect',
                    isTypeOnly: false,
                    range: {
                        startLine: node.startPosition.row,
                        endLine: node.endPosition.row,
                        startByte: node.startIndex,
                        endByte: node.endIndex,
                    }
                });
            }
        }
        return results;
    }

    private processExport(node: any, langName: string): ExportSymbol[] {
        const results: ExportSymbol[] = [];
        if (langName === 'typescript' || langName === 'tsx' || langName === 'javascript') {
             const isTypeOnly = node.children.some((c: any) => c.type === 'type' || c.text === 'type');
             const sourceNode = node.childForFieldName('source');
             const source = sourceNode ? sourceNode.text.slice(1, -1) : undefined;
             
             // 1. Export Clause (export { ... } [from ...])
             const exportClause = node.children.find((c: any) => c.type === 'export_clause');
             if (exportClause) {
                 const exportsList: { name: string; alias?: string }[] = [];
                 for (const child of exportClause.children) {
                     if (child.type === 'export_specifier') {
                         const nameNode = child.childForFieldName('name');
                         const aliasNode = child.childForFieldName('alias');
                         if (nameNode) {
                             exportsList.push({
                                 name: nameNode.text,
                                 alias: aliasNode ? aliasNode.text : undefined
                             });
                         }
                     }
                 }
                 results.push({
                     type: 'export',
                     name: source ? `re-export from ${source}` : 'named exports',
                     exportKind: source ? 're-export' : 'named',
                     source,
                     exports: exportsList,
                     isTypeOnly,
                     range: {
                        startLine: node.startPosition.row,
                        endLine: node.endPosition.row,
                        startByte: node.startIndex,
                        endByte: node.endIndex,
                    }
                 });
             }
             
             // 2. Namespace Re-export (export * from 'b')
             const starNode = node.children.find((c: any) => c.type === '*');
             if (starNode && source) {
                  results.push({
                     type: 'export',
                     name: `* from ${source}`,
                     exportKind: 're-export', 
                     source,
                     isTypeOnly,
                     range: {
                        startLine: node.startPosition.row,
                        endLine: node.endPosition.row,
                        startByte: node.startIndex,
                        endByte: node.endIndex,
                    }
                 });
             }

             // 3. Local / Default Exports (via declaration field)
             const isDefault = node.children.some((c: any) => c.type === 'default' || c.text === 'default');
             const declaration = node.childForFieldName('declaration');
             
             if (declaration) {
                 if (isDefault) {
                     // export default class/function
                     const nameNode = declaration.childForFieldName('name');
                     const name = nameNode ? nameNode.text : 'default';
                     results.push({
                         type: 'export',
                         name: name,
                         exportKind: 'default',
                         isTypeOnly,
                         range: {
                            startLine: node.startPosition.row,
                            endLine: node.endPosition.row,
                            startByte: node.startIndex,
                            endByte: node.endIndex,
                        }
                     });
                 } else {
                     // export class/function/const
                     const exportsList: { name: string; alias?: string }[] = [];
                     
                     if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
                         for (const child of declaration.children) {
                             if (child.type === 'variable_declarator') {
                                 const nameNode = child.childForFieldName('name');
                                 if (nameNode) exportsList.push({ name: nameNode.text });
                             }
                         }
                     } else {
                         // function/class/interface/type_alias
                         const nameNode = declaration.childForFieldName('name');
                         if (nameNode) exportsList.push({ name: nameNode.text });
                     }

                     if (exportsList.length > 0) {
                         results.push({
                             type: 'export',
                             name: 'local exports',
                             exportKind: 'named',
                             exports: exportsList,
                             isTypeOnly,
                             range: {
                                startLine: node.startPosition.row,
                                endLine: node.endPosition.row,
                                startByte: node.startIndex,
                                endByte: node.endIndex,
                            }
                         });
                     }
                 }
             } else if (isDefault) {
                 // export default expression; (e.g. export default 1;)
                 const valueNode = node.children.find((c: any) => 
                    c.type !== 'export' && c.type !== 'default' && c.type !== ';' && c.type !== 'type'
                 );
                 if (valueNode) {
                     results.push({
                         type: 'export',
                         name: 'default',
                         exportKind: 'default',
                         isTypeOnly,
                         range: {
                            startLine: node.startPosition.row,
                            endLine: node.endPosition.row,
                            startByte: node.startIndex,
                            endByte: node.endIndex,
                        }
                     });
                 }
             }
        }
        return results;
    }

    private getLanguageConfig(filePath: string): FoldQuery | undefined {
        const ext = filePath.split('.').pop()?.toLowerCase();
        if (['ts', 'mts', 'cts'].includes(ext!)) return LANGUAGE_CONFIG.typescript;
        if (['tsx'].includes(ext!)) return LANGUAGE_CONFIG.tsx;
        if (['js', 'mjs', 'cjs', 'jsx'].includes(ext!)) return LANGUAGE_CONFIG.javascript;
        if (['py'].includes(ext!)) return LANGUAGE_CONFIG.python;
        return undefined;
    }

    private resolveSymbolType(node: any): DefinitionSymbol['type'] | undefined {
        switch (node.type) {
            case 'class_declaration':
            case 'class_definition':
                return 'class';
            case 'interface_declaration':
                return 'interface';
            case 'method_definition':
                return 'method';
            case 'function_declaration':
            case 'function_definition':
                return 'function';
            case 'variable_declarator':
                return 'variable';
            default:
                return undefined;
        }
    }

    private extractParameterNames(node: any): string[] {
        const paramsNode = node.childForFieldName('parameters');
        if (!paramsNode) {
            return [];
        }

        return paramsNode.children
            .filter((child: any) =>
                child.type === 'identifier' ||
                child.type === 'required_parameter' ||
                child.type === 'optional_parameter' ||
                child.type === 'rest_parameter' ||
                child.type === 'default_parameter' ||
                child.type === 'typed_parameter')
            .map((child: any) => {
                if (child.type === 'identifier') {
                    return child.text;
                }
                const nameField = child.childForFieldName ? child.childForFieldName('name') : null;
                if (nameField) {
                    return nameField.text;
                }
                const identifierChild = child.namedChildren?.find((c: any) => c.type === 'identifier');
                return identifierChild ? identifierChild.text : child.text;
            });
    }

    private extractReturnType(node: any): string | undefined {
        const returnNode = node.childForFieldName('return_type');
        return returnNode ? returnNode.text : undefined;
    }
}
