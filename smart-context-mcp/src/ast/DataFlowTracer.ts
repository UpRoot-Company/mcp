import path from "path";
import { AstManager } from "./AstManager.js";
import { SymbolIndex } from "./SymbolIndex.js";
import { DataFlowEdge, DataFlowResult, DataFlowStep, DataFlowStepType, DefinitionSymbol, SymbolInfo } from "../types.js";
import { IFileSystem } from "../platform/FileSystem.js";

interface RawOccurrence {
    step: DataFlowStep;
    sortKey: number;
}

interface StepClassification {
    stepType: DataFlowStepType;
    metadata?: Record<string, unknown>;
    highlightNode?: any;
}

export class DataFlowTracer {
    private readonly astManager = AstManager.getInstance();

    constructor(
        private readonly rootPath: string,
        private readonly symbolIndex: SymbolIndex,
        private readonly fileSystem: IFileSystem
    ) {}

    public async traceVariable(
        variableName: string,
        filePath: string,
        fromLine?: number,
        maxSteps: number = 10
    ): Promise<DataFlowResult | null> {
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        let content: string;
        try {
            content = await this.fileSystem.readFile(absPath);
        } catch {
            return null;
        }

        const symbols = await this.symbolIndex.getSymbolsForFile(absPath);
        const scopeDefinition = this.findContainingDefinition(symbols, fromLine);

        let doc: any;
        try {
            doc = await this.astManager.parseFile(absPath, content);
        } catch {
            return null;
        }

        try {
            const occurrences = this.collectOccurrences({
                rootNode: doc.rootNode,
                variableName,
                content,
                scopeDefinition,
                filePath: this.normalizeRelativePath(absPath)
            });

            if (occurrences.length === 0) {
                return null;
            }

            occurrences.sort((a, b) => a.sortKey - b.sortKey);
            const sourceIndex = this.pickSourceIndex(occurrences, fromLine);
            if (sourceIndex < 0) {
                return null;
            }

            const boundedMax = Math.max(1, Math.floor(maxSteps));
            const window = occurrences.slice(sourceIndex, sourceIndex + boundedMax);
            const truncated = occurrences.length > sourceIndex + window.length;

            const orderedStepIds = window.map(item => item.step.id);
            const steps: Record<string, DataFlowStep> = {};
            for (const item of window) {
                steps[item.step.id] = item.step;
            }

            const edges: DataFlowEdge[] = [];
            for (let i = 0; i < window.length - 1; i++) {
                edges.push({
                    fromStepId: window[i].step.id,
                    toStepId: window[i + 1].step.id,
                    relation: "next"
                });
            }

            return {
                sourceStepId: window[0].step.id,
                steps,
                orderedStepIds,
                edges,
                truncated
            };
        } finally {
            doc?.dispose?.();
        }
    }

    private normalizeRelativePath(absPath: string): string {
        const relative = path.relative(this.rootPath, absPath);
        return relative || path.basename(absPath);
    }

    private findContainingDefinition(symbols: SymbolInfo[], fromLine?: number): DefinitionSymbol | undefined {
        if (!Number.isFinite(fromLine) || fromLine === undefined) {
            return undefined;
        }
        const zeroBasedLine = Math.max(0, Math.floor(fromLine) - 1);
        return symbols.find((symbol): symbol is DefinitionSymbol => this.isDefinition(symbol) &&
            zeroBasedLine >= symbol.range.startLine && zeroBasedLine <= symbol.range.endLine
        );
    }

    private isDefinition(symbol: SymbolInfo): symbol is DefinitionSymbol {
        return symbol.type !== "import" && symbol.type !== "export";
    }

    private pickSourceIndex(occurrences: RawOccurrence[], fromLine?: number): number {
        const definitionIndex = occurrences.findIndex(item =>
            item.step.stepType === "definition" || item.step.stepType === "parameter"
        );

        if (Number.isFinite(fromLine) && fromLine !== undefined) {
            for (let i = 0; i < occurrences.length; i++) {
                const step = occurrences[i].step;
                if (fromLine >= step.range.startLine && fromLine <= step.range.endLine) {
                    if (definitionIndex >= 0 && definitionIndex <= i) {
                        return definitionIndex;
                    }
                    return i;
                }
            }
        }
        if (definitionIndex >= 0) {
            return definitionIndex;
        }
        return 0;
    }

    private collectOccurrences(params: {
        rootNode: any;
        variableName: string;
        content: string;
        scopeDefinition?: DefinitionSymbol;
        filePath: string;
    }): RawOccurrence[] {
        const { rootNode, variableName, content, scopeDefinition, filePath } = params;
        const results: RawOccurrence[] = [];
        const scopeStart = scopeDefinition ? scopeDefinition.range.startLine : null;
        const scopeEnd = scopeDefinition ? scopeDefinition.range.endLine : null;

        const visit = (node: any) => {
            if (!node) return;
            if (this.isIdentifierNode(node) && node.text === variableName) {
                const assignmentAncestor = this.findAncestor(node, ancestor => ancestor.type === "assignment_expression");
                if (assignmentAncestor) {
                    const leftSide = assignmentAncestor.childForFieldName?.("left");
                    if (leftSide?.text === variableName && !this.nodesEqual(leftSide, node)) {
                        // Skip the right-hand occurrence when assigning the same variable to itself.
                        return;
                    }
                }

                if (this.isWithinScope(node, scopeStart, scopeEnd)) {
                    const classification = this.classifyNode(node, variableName, content);
                    const highlightNode = classification.highlightNode || node;
                    const step = this.buildStep({
                        node: highlightNode,
                        stepType: classification.stepType,
                        metadata: classification.metadata,
                        symbolName: scopeDefinition?.name,
                        content,
                        filePath
                    });
                    results.push({ step, sortKey: highlightNode.startIndex });
                }
            }

            if (node.namedChildren) {
                for (const child of node.namedChildren) {
                    visit(child);
                }
            }
        };

        visit(rootNode);
        return results;
    }

    private isIdentifierNode(node: any): boolean {
        return node.type === "identifier" || node.type === "shorthand_property_identifier" || node.type === "type_identifier";
    }

    private isWithinScope(node: any, scopeStart: number | null, scopeEnd: number | null): boolean {
        if (scopeStart === null || scopeEnd === null) {
            return true;
        }
        const line = node.startPosition?.row ?? 0;
        return line >= scopeStart && line <= scopeEnd;
    }

    private classifyNode(node: any, variableName: string, content: string): StepClassification {
        // 1) Argument usage should win early to avoid being shadowed by outer assignments.
        const callMetadata = this.getCallArgumentMetadata(node);
        if (callMetadata) {
            return {
                stepType: "call_argument",
                metadata: callMetadata.metadata,
                highlightNode: callMetadata.highlightNode
            };
        }

        // 2) Parameters
        const parameterNode = this.findAncestor(node, ancestor => this.isParameterContainer(ancestor));
        if (parameterNode && this.parameterContainsNode(parameterNode, node)) {
            return { stepType: "parameter", highlightNode: parameterNode };
        }

        // 3) Variable declarations
        const declarator = this.findDefinitionDeclarator(node);
        if (declarator) {
            return { stepType: "definition", highlightNode: declarator };
        }

        // 4) Assignments / updates
        const assignment = this.findAncestor(node, ancestor => ancestor.type === "assignment_expression");
        if (assignment && this.nodesEqual(assignment.childForFieldName?.("left"), node)) {
            return { stepType: "assignment", highlightNode: assignment };
        }

        const mutation = this.findAncestor(node, ancestor => ancestor.type === "update_expression");
        if (mutation) {
            return { stepType: "mutation", highlightNode: mutation };
        }

        // 5) Return statements
        const returnNode = this.findAncestor(node, ancestor => ancestor.type === "return_statement");
        if (returnNode) {
            return { stepType: "return", highlightNode: returnNode };
        }

        // 6) Heuristics fallback
        const heuristic = this.classifyByHeuristics(node, variableName, content);
        if (heuristic) {
            return heuristic;
        }

        return { stepType: "usage" };
    }

    private classifyByHeuristics(node: any, variableName: string, content: string): StepClassification | null {
        const { lineText } = this.getLineInfo(node, content);
        const escaped = this.escapeRegExp(variableName);

        const definitionRegex = new RegExp(`\\b(let|const|var)\\s+${escaped}\\b`);
        if (definitionRegex.test(lineText)) {
            return { stepType: "definition" };
        }

        const assignmentRegex = new RegExp(`\\b${escaped}\\b\\s*=`);
        if (assignmentRegex.test(lineText)) {
            return { stepType: "assignment" };
        }

        const returnRegex = new RegExp(`return[^;]*${escaped}`);
        if (returnRegex.test(lineText)) {
            return { stepType: "return" };
        }

        const callRegex = /([A-Za-z0-9_$.]+)\s*\(([^)]*)\)/;
        const callMatch = callRegex.exec(lineText);
        if (callMatch && new RegExp(`\\b${escaped}\\b`).test(callMatch[2])) {
            const argsSegment = callMatch[2];
            const occurrenceIndex = argsSegment.indexOf(variableName);
            let argumentIndex = 0;
            if (occurrenceIndex > 0) {
                const preceding = argsSegment.slice(0, occurrenceIndex);
                argumentIndex = preceding.split(",").filter(part => part.trim().length > 0).length;
            }
            return {
                stepType: "call_argument",
                metadata: {
                    calleeName: callMatch[1],
                    argumentIndex,
                    callText: lineText.trim()
                }
            };
        }

        return null;
    }

    private getLineInfo(node: any, content: string): { lineText: string } {
        const start = node.startIndex;
        const end = node.endIndex;
        const lineStart = start <= 0 ? 0 : content.lastIndexOf("\n", start - 1) + 1;
        const lineEndRaw = content.indexOf("\n", end);
        const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
        return {
            lineText: content.slice(lineStart, lineEnd)
        };
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private parameterContainers = new Set([
        "required_parameter",
        "optional_parameter",
        "rest_parameter",
        "typed_parameter",
        "formal_parameters"
    ]);

    private isParameterContainer(node: any): boolean {
        return this.parameterContainers.has(node.type);
    }

    private parameterContainsNode(container: any, node: any): boolean {
        if (!container) return false;
        const nameField = container.childForFieldName?.("name");
        if (this.nodesEqual(nameField, node)) {
            return true;
        }
        return container.namedChildren?.some((child: any) => this.nodesEqual(child, node)) ?? false;
    }

    private findDefinitionDeclarator(node: any): any | null {
        const direct = this.findAncestor(node, ancestor => ancestor.type === "variable_declarator");
        if (direct && this.nodesEqual(this.getDeclaratorNameNode(direct), node)) {
            return direct;
        }

        const lexical = this.findAncestor(node, ancestor =>
            ancestor.type === "lexical_declaration" || ancestor.type === "variable_declaration"
        );
        if (!lexical) {
            return null;
        }

        for (const child of lexical.namedChildren ?? []) {
            if (child.type !== "variable_declarator") continue;
            const nameField = this.getDeclaratorNameNode(child);
            if (this.nodesEqual(nameField, node)) {
                return child;
            }
        }

        return null;
    }

    private getDeclaratorNameNode(declarator: any): any | null {
        const nameField = declarator.childForFieldName?.("name");
        if (nameField) {
            return nameField;
        }
        return declarator.namedChildren?.find((child: any) => this.isIdentifierNode(child)) ?? null;
    }

    private nodesEqual(left: any, right: any): boolean {
        if (!left || !right) return false;
        if (left === right) return true;
        return left.startIndex === right.startIndex && left.endIndex === right.endIndex;
    }

    private isDescendantOf(node: any, ancestor: any): boolean {
        let current = node;
        while (current) {
            if (current === ancestor) {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    private findAncestor(node: any, predicate: (candidate: any) => boolean): any | null {
        let current = node.parent;
        while (current) {
            if (predicate(current)) {
                return current;
            }
            current = current.parent;
        }
        return null;
    }


    private getCallArgumentMetadata(node: any): { metadata: Record<string, unknown>; highlightNode: any } | null {
        const callExpression = this.findAncestor(node, ancestor => ancestor.type === "call_expression" || ancestor.type === "new_expression");
        if (!callExpression) {
            return null;
        }

        const argumentsNode = callExpression.childForFieldName?.("arguments");
        if (!argumentsNode || !this.isDescendantOf(node, argumentsNode)) {
            return null;
        }

        const argumentRoot = this.getArgumentRoot(node, argumentsNode);
        const argumentIndex = this.findArgumentIndex(argumentsNode, argumentRoot);
        if (argumentIndex < 0) {
            return null;
        }

        const calleeNode = callExpression.childForFieldName?.("function") || callExpression.childForFieldName?.("constructor");
        const calleeName = this.extractCalleeName(calleeNode);

        return {
            metadata: {
                calleeName,
                argumentIndex,
                callText: callExpression.text
            },
            highlightNode: argumentRoot
        };
    }

    private getArgumentRoot(node: any, argumentsNode: any): any {
        let current = node;
        while (current.parent && current.parent !== argumentsNode) {
            current = current.parent;
        }
        return current;
    }

    private findArgumentIndex(argumentsNode: any, argumentRoot: any): number {
        let index = 0;
        for (const child of argumentsNode.namedChildren ?? []) {
            if (child === argumentRoot || this.isDescendantOf(argumentRoot, child)) {
                return index;
            }
            index++;
        }
        return -1;
    }

    private extractCalleeName(node: any): string | undefined {
        if (!node) return undefined;
        if (node.type === "identifier" || node.type === "type_identifier") {
            return node.text;
        }
        if (node.type === "member_expression") {
            const property = node.childForFieldName?.("property");
            if (property) {
                return property.text;
            }
        }
        return undefined;
    }

    private buildStep(params: {
        node: any;
        stepType: DataFlowStepType;
        metadata?: Record<string, unknown>;
        symbolName?: string;
        content: string;
        filePath: string;
    }): DataFlowStep {
        const { node, stepType, metadata, symbolName, content, filePath } = params;
        const range = {
            startLine: node.startPosition.row + 1,
            startColumn: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
            endColumn: node.endPosition.column + 1
        };

        return {
            id: `${filePath}:${node.startIndex}:${node.endIndex}:${stepType}`,
            stepType,
            filePath,
            range,
            textSnippet: content.slice(node.startIndex, node.endIndex).trim(),
            symbolName,
            metadata
        };
    }
}
