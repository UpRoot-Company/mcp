import { DefinitionSymbol } from '../types.js';

/**
 * Type of AST-level change detected
 */
export type AstChangeType = 
    | 'signature-change'
    | 'visibility-change'
    | 'type-change'
    | 'parameter-add'
    | 'parameter-remove'
    | 'parameter-reorder'
    | 'return-type-change'
    | 'rename'
    | 'add'
    | 'remove';

/**
 * Represents a detected change between two AST states
 */
export interface AstChange {
    type: AstChangeType;
    symbolName: string;
    symbolType: DefinitionSymbol['type'];
    isBreaking: boolean;
    oldSignature?: string;
    newSignature?: string;
    details?: Record<string, unknown>;
}

/**
 * Result of comparing two AST states
 */
export interface AstDiffResult {
    changes: AstChange[];
    hasBreakingChanges: boolean;
    affectedSymbols: Set<string>;
}

/**
 * AstDiffEngine detects structural changes between two versions of source code.
 * Uses regex-based heuristics for TypeScript/JavaScript code.
 */
export class AstDiffEngine {
    constructor() {}

    /**
     * Compare two versions of source code and detect structural changes
     */
    public async diff(
        filePath: string,
        oldContent: string,
        newContent: string
    ): Promise<AstDiffResult> {
        const changes: AstChange[] = [];

        // Extract exported functions
        const oldFuncs = this.extractFunctions(oldContent);
        const newFuncs = this.extractFunctions(newContent);

        // Detect function changes
        for (const [name, oldSig] of oldFuncs) {
            const newSig = newFuncs.get(name);
            if (!newSig) {
                // Function removed
                changes.push({
                    type: 'remove',
                    symbolName: name,
                    symbolType: 'function',
                    isBreaking: true,
                    oldSignature: oldSig
                });
            } else if (oldSig !== newSig) {
                // Signature changed
                const paramChange = this.detectParamChange(oldSig, newSig);
                if (paramChange) {
                    changes.push(paramChange);
                }
                
                changes.push({
                    type: 'signature-change',
                    symbolName: name,
                    symbolType: 'function',
                    isBreaking: true,
                    oldSignature: oldSig,
                    newSignature: newSig
                });
            }
        }

        // Detect new functions
        for (const [name, newSig] of newFuncs) {
            if (!oldFuncs.has(name)) {
                changes.push({
                    type: 'add',
                    symbolName: name,
                    symbolType: 'function',
                    isBreaking: false,
                    newSignature: newSig
                });
            }
        }

        // Extract classes
        const oldClasses = this.extractClasses(oldContent);
        const newClasses = this.extractClasses(newContent);

        // Detect class changes
        for (const name of oldClasses) {
            if (!newClasses.has(name)) {
                changes.push({
                    type: 'remove',
                    symbolName: name,
                    symbolType: 'class',
                    isBreaking: true
                });
            }
        }

        for (const name of newClasses) {
            if (!oldClasses.has(name)) {
                changes.push({
                    type: 'add',
                    symbolName: name,
                    symbolType: 'class',
                    isBreaking: false
                });
            }
        }

        return {
            changes,
            hasBreakingChanges: changes.some(c => c.isBreaking),
            affectedSymbols: new Set(changes.map(c => c.symbolName))
        };
    }

    /**
     * Extract exported functions from code
     */
    private extractFunctions(content: string): Map<string, string> {
        const funcs = new Map<string, string>();
        
        // Match: export function name(params)
        const pattern = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
        let match;
        
        while ((match = pattern.exec(content)) !== null) {
            const name = match[1];
            const params = match[2];
            funcs.set(name, `function ${name}(${params})`);
        }

        return funcs;
    }

    /**
     * Extract exported classes from code
     */
    private extractClasses(content: string): Set<string> {
        const classes = new Set<string>();
        
        // Match: export class Name
        const pattern = /export\s+class\s+(\w+)/g;
        let match;
        
        while ((match = pattern.exec(content)) !== null) {
            classes.add(match[1]);
        }

        return classes;
    }

    /**
     * Detect parameter changes between two function signatures
     */
    private detectParamChange(oldSig: string, newSig: string): AstChange | null {
        const oldParams = this.extractParamList(oldSig);
        const newParams = this.extractParamList(newSig);

        if (oldParams.length === newParams.length) {
            return null;
        }

        const funcName = oldSig.match(/function\s+(\w+)/)?.[1] || 'unknown';

        if (newParams.length > oldParams.length) {
            return {
                type: 'parameter-add',
                symbolName: funcName,
                symbolType: 'function',
                isBreaking: true,
                details: {
                    oldCount: oldParams.length,
                    newCount: newParams.length,
                    added: newParams.slice(oldParams.length)
                }
            };
        } else {
            return {
                type: 'parameter-remove',
                symbolName: funcName,
                symbolType: 'function',
                isBreaking: true,
                details: {
                    oldCount: oldParams.length,
                    newCount: newParams.length,
                    removed: oldParams.slice(newParams.length)
                }
            };
        }
    }

    /**
     * Extract parameter list from function signature
     */
    private extractParamList(signature: string): string[] {
        const match = signature.match(/\(([^)]*)\)/);
        if (!match || !match[1].trim()) {
            return [];
        }

        return match[1].split(',').map(p => p.trim()).filter(p => p.length > 0);
    }
}
