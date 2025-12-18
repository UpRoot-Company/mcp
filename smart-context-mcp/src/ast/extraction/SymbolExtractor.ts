import { Query } from 'web-tree-sitter';
import { DefinitionSymbol, ExportSymbol, ImportSymbol, SymbolInfo } from '../../types.js';
import { CallSiteAnalyzer } from '../analysis/CallSiteAnalyzer.js';
import { DocumentationExtractor } from './DocumentationExtractor.js';

export class SymbolExtractor {
    private extractionQueryCache = new Map<string, Query>();
    private docExtractor = new DocumentationExtractor();
    private callSiteAnalyzer = new CallSiteAnalyzer();

    public async generateStructureJson(
        filePath: string, 
        content: string,
        astManager: any // AstManager dependency
    ): Promise<SymbolInfo[]> {
        if (typeof content !== 'string') return [];

        let doc;
        try {
            doc = await astManager.parseFile(filePath, content);
        } catch (e) {
            return [];
        }

        const lang = await astManager.getLanguageForFile(filePath);
        if (!lang || !astManager.supportsQueries()) return [];
        const langId = astManager.getLanguageId(filePath);

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
                        (type_alias_declaration name: (type_identifier) @name) @definition
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
                this.callSiteAnalyzer.attachCallSiteMetadata(rootNode, lang, langId, definitionNodeMap);
            }

        } catch (error) {
            console.error(`Error generating JSON skeleton for ${filePath}:`, error);
            throw error; 
        } finally {
            doc?.dispose?.();
        }

        return symbols;
    }

    private makeNodeKey(node: any): string {
        const start = typeof node.startIndex === 'number' ? node.startIndex : 0;
        const end = typeof node.endIndex === 'number' ? node.endIndex : start;
        const idPart = typeof node.id === 'number' || typeof node.id === 'string'
            ? String(node.id)
            : '';
        return `${idPart}:${start}:${end}`;
    }

    public processDefinition(definitionNode: any, nameNode: any, langName: string): DefinitionSymbol | null {
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

        const parameters = this.docExtractor.extractParameterNames(definitionNode);
        const returnType = this.docExtractor.extractReturnType(definitionNode);
        const doc = this.docExtractor.extractDocumentation(definitionNode, langName);
        
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

    public processImport(node: any, langName: string): ImportSymbol[] {
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

    public processExport(node: any, langName: string): ExportSymbol[] {
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
            case 'type_alias_declaration':
                return 'type_alias';
            default:
                return undefined;
        }
    }
}
