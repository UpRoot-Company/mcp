export class DocumentationExtractor {
    public extractDocumentation(node: any, langName: string): string | undefined {
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

    public extractParameterNames(node: any): string[] {
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
                
                if (child.type === 'rest_parameter') {
                    if (child.children) {
                        const identifierChild = child.children.find((c: any) => c.type === 'identifier');
                        if (identifierChild) return identifierChild.text;
                    }
                }

                const nameField = child.childForFieldName ? (child.childForFieldName('name') || child.childForFieldName('pattern')) : null;
                if (nameField) {
                    return nameField.text;
                }
                
                // Fallback: try to find first identifier child if fields fail
                if (child.children) {
                    const identifierChild = child.children.find((c: any) => c.type === 'identifier');
                    if (identifierChild) return identifierChild.text;
                }

                return child.text;
            });
    }

    public extractReturnType(node: any): string | undefined {
        const returnNode = node.childForFieldName('return_type');
        return returnNode ? returnNode.text : undefined;
    }
}
