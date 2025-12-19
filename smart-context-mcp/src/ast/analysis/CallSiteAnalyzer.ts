import { Query } from 'web-tree-sitter';
import { CallSiteInfo, CallType, DefinitionSymbol } from '../../types.js';

export class CallSiteAnalyzer {
    private callQueryCache = new Map<string, Query>();

    public attachCallSiteMetadata(
        rootNode: any, 
        lang: any, 
        langId: string, 
        definitionNodeMap: Map<string, DefinitionSymbol>
    ) {
        const calls = this.extractCallSites(rootNode, lang, langId);
        for (const callInfo of calls) {
            const owner = this.findOwningDefinition(callInfo.node, definitionNodeMap);
            if (!owner) continue;

            if (!owner.calls) {
                owner.calls = [];
            }
            owner.calls.push(callInfo);
        }
    }

    public extractCallSites(rootNode: any, lang: any, langId: string): (CallSiteInfo & { node: any })[] {
        const query = this.getCallQuery(langId, lang);
        if (!query) return [];

        const results: (CallSiteInfo & { node: any })[] = [];
        const matches = query.matches(rootNode);
        for (const match of matches) {
            const parsed = this.parseCallMatch(match);
            if (!parsed) continue;

            results.push({
                calleeName: parsed.calleeName,
                calleeObject: parsed.calleeObject,
                callType: parsed.callType,
                line: parsed.node.startPosition.row + 1,
                column: parsed.node.startPosition.column + 1,
                text: parsed.node.text,
                node: parsed.node,
                arguments: this.extractArguments(parsed.node, langId),
                isAwaited: this.checkIfAwaited(parsed.node, langId)
            });
        }
        return results;
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

    private extractArguments(node: any, langId: string): string[] {
        const args: string[] = [];
        if (['typescript', 'tsx', 'javascript'].includes(langId)) {
            const argsNode = node.child?.(1) || node.lastChild; // Simplified
            if (argsNode?.type === 'arguments') {
                for (let i = 0; i < argsNode.namedChildCount; i++) {
                    args.push(argsNode.namedChild(i).text);
                }
            }
        }
        if (langId === 'python') {
            const argsNode = node.lastChild;
            if (argsNode?.type === 'argument_list') {
                for (let i = 0; i < argsNode.namedChildCount; i++) {
                    args.push(argsNode.namedChild(i).text);
                }
            }
        }
        return args;
    }

    private checkIfAwaited(node: any, langId: string): boolean {
        if (['typescript', 'tsx', 'javascript'].includes(langId)) {
            return node.parent?.type === 'await_expression';
        }
        if (langId === 'python') {
            return node.parent?.type === 'await';
        }
        return false;
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
}
