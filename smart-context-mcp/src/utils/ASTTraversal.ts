export class ASTTraversal {
    public findParent(node: any, predicate: (n: any) => boolean): any | undefined {
        let current = node.parent;
        while (current) {
            if (predicate(current)) {
                return current;
            }
            current = current.parent;
        }
        return undefined;
    }

    public traverseSiblings(node: any, direction: 'prev' | 'next'): any[] {
        const siblings: any[] = [];
        let current = direction === 'prev' ? node.previousSibling : node.nextSibling;
        
        while (current) {
            siblings.push(current);
            current = direction === 'prev' ? current.previousSibling : current.nextSibling;
        }
        
        return siblings;
    }
}
