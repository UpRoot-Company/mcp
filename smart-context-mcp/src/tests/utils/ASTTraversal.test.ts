import { ASTTraversal } from '../../utils/ASTTraversal.js';

describe('ASTTraversal', () => {
    let traversal: ASTTraversal;

    beforeEach(() => {
        traversal = new ASTTraversal();
    });

    test('should find parent node matching predicate', () => {
        const parent = { type: 'class_declaration', parent: null };
        const child = { type: 'method_definition', parent: parent };
        const leaf = { type: 'identifier', parent: child };

        const found = traversal.findParent(leaf, (n: any) => n.type === 'class_declaration');
        expect(found).toBe(parent);
    });

    test('should return undefined if no parent matches', () => {
        const parent = { type: 'function_declaration', parent: null };
        const child = { type: 'identifier', parent: parent };

        const found = traversal.findParent(child, (n: any) => n.type === 'class_declaration');
        expect(found).toBeUndefined();
    });

    test('should traverse siblings', () => {
        const node1 = { id: 1, nextSibling: null, previousSibling: null };
        const node2 = { id: 2, nextSibling: null, previousSibling: node1 };
        const node3 = { id: 3, nextSibling: null, previousSibling: node2 };
        
        // Link forward
        (node1 as any).nextSibling = node2;
        (node2 as any).nextSibling = node3;

        const nextSiblings = traversal.traverseSiblings(node1, 'next');
        expect(nextSiblings).toHaveLength(2);
        expect(nextSiblings[0]).toBe(node2);
        expect(nextSiblings[1]).toBe(node3);

        const prevSiblings = traversal.traverseSiblings(node3, 'prev');
        expect(prevSiblings).toHaveLength(2);
        expect(prevSiblings[0]).toBe(node2);
        expect(prevSiblings[1]).toBe(node1);
    });
});
