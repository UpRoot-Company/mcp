import path from 'path';
import { DefinitionSymbol, SymbolInfo, CallConfidence, TypeGraphEdge, TypeGraphNode, TypeGraphResult, TypeRelationKind } from '../types.js';
import { SymbolIndex } from './SymbolIndex.js';

export type TypeDependencyDirection = 'incoming' | 'outgoing' | 'both';

interface DefinitionLocation {
    definition: DefinitionSymbol;
    absolutePath: string;
    relativePath: string;
}

interface TypeRelation {
    targetName: string;
    relationKind: TypeRelationKind;
    confidence: CallConfidence;
}

interface IncomingRelationEntry {
    source: DefinitionLocation;
    relationKind: TypeRelationKind;
    confidence: CallConfidence;
}

interface TypeRegistry {
    definitionsByName: Map<string, DefinitionLocation[]>;
    incomingRelations: Map<string, IncomingRelationEntry[]>;
    relationsBySymbolId: Map<string, TypeRelation[]>;
}

interface QueueItem {
    symbolId: string;
    depth: number;
}

const TYPE_DEFINITION_KINDS: Array<DefinitionSymbol['type']> = ['class', 'interface', 'type_alias'];
const STOP_WORDS = new Set<string>([
    'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
    'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'keyof', 'let', 'new', 'null', 'number', 'object',
    'package', 'private', 'protected', 'public', 'readonly', 'return', 'static', 'string', 'super', 'switch', 'symbol',
    'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var', 'void', 'while', 'with', 'yield'
]);
const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'null', 'undefined', 'object', 'symbol', 'bigint']);

export class TypeDependencyTracker {
    private registry: TypeRegistry | null = null;
    private definitionCache = new Map<string, DefinitionLocation>();
    private buildingRegistry: Promise<TypeRegistry> | null = null;

    constructor(
        private readonly rootPath: string,
        private readonly symbolIndex: SymbolIndex
    ) {}

    public async analyzeType(
        symbolName: string,
        filePath: string,
        direction: TypeDependencyDirection = 'both',
        maxDepth = 2
    ): Promise<TypeGraphResult | null> {
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        const relativePath = this.normalizeRelativePath(absPath);
        const symbols = await this.symbolIndex.getSymbolsForFile(absPath);
        const definition = symbols.find((symbol): symbol is DefinitionSymbol => this.isTypeDefinition(symbol) && symbol.name === symbolName);
        if (!definition) {
            return null;
        }

        const registry = await this.ensureRegistry();
        const symbolId = this.makeSymbolId(relativePath, symbolName);
        const rootLocation: DefinitionLocation = { definition, absolutePath: absPath, relativePath };
        this.definitionCache.set(symbolId, rootLocation);

        const rootNode = this.createGraphNode(symbolId, rootLocation);
        const visitedNodes: Record<string, TypeGraphNode> = { [symbolId]: rootNode };
        const queue: QueueItem[] = [{ symbolId, depth: 0 }];
        const enqueued = new Set<string>([symbolId]);
        let truncated = false;

        while (queue.length > 0) {
            const { symbolId: currentId, depth } = queue.shift()!;
            const location = this.definitionCache.get(currentId);
            const node = visitedNodes[currentId];
            if (!location || !node) {
                continue;
            }

            if ((direction === 'outgoing' || direction === 'both')) {
                const outgoingTruncated = await this.populateOutgoing(
                    node,
                    location,
                    registry,
                    depth,
                    maxDepth,
                    queue,
                    enqueued,
                    visitedNodes
                );
                truncated = truncated || outgoingTruncated;
            }

            if ((direction === 'incoming' || direction === 'both')) {
                const incomingTruncated = this.populateIncoming(
                    node,
                    location,
                    registry,
                    depth,
                    maxDepth,
                    queue,
                    enqueued,
                    visitedNodes
                );
                truncated = truncated || incomingTruncated;
            }
        }

        return {
            root: rootNode,
            visitedNodes,
            truncated,
        };
    }

    public invalidateFile(filePath: string) {
        const relativePath = this.normalizeRelativePath(filePath);
        for (const key of Array.from(this.definitionCache.keys())) {
            if (key.startsWith(`${relativePath}::`)) {
                this.definitionCache.delete(key);
            }
        }
        this.registry = null;
    }

    public invalidateDirectory(dirPath: string) {
        const relative = this.normalizeRelativePath(dirPath);
        for (const key of Array.from(this.definitionCache.keys())) {
            if (key.startsWith(`${relative}`)) {
                this.definitionCache.delete(key);
            }
        }
        this.registry = null;
    }

    public clearCaches() {
        this.registry = null;
        this.definitionCache.clear();
        this.buildingRegistry = null;
    }

    private async ensureRegistry(): Promise<TypeRegistry> {
        if (this.registry) {
            return this.registry;
        }
        if (this.buildingRegistry) {
            return this.buildingRegistry;
        }
        this.buildingRegistry = this.buildRegistry();
        this.registry = await this.buildingRegistry;
        this.buildingRegistry = null;
        return this.registry;
    }

    private async buildRegistry(): Promise<TypeRegistry> {
        const allSymbols = await this.symbolIndex.getAllSymbols();
        const definitionsByName = new Map<string, DefinitionLocation[]>();
        const incomingRelations = new Map<string, IncomingRelationEntry[]>();
        const relationsBySymbolId = new Map<string, TypeRelation[]>();

        for (const [relativePath, symbols] of allSymbols.entries()) {
            const absPath = path.join(this.rootPath, relativePath);
            for (const symbol of symbols) {
                if (!this.isTypeDefinition(symbol)) continue;
                const definition = symbol as DefinitionSymbol;
                if (!definition.name) continue;

                const location: DefinitionLocation = { definition, absolutePath: absPath, relativePath };
                const symbolId = this.makeSymbolId(relativePath, definition.name);
                this.definitionCache.set(symbolId, location);

                if (!definitionsByName.has(definition.name)) {
                    definitionsByName.set(definition.name, []);
                }
                definitionsByName.get(definition.name)!.push(location);

                const relations = this.extractTypeRelations(definition);
                relationsBySymbolId.set(symbolId, relations);

                for (const relation of relations) {
                    const list = incomingRelations.get(relation.targetName) || [];
                    list.push({
                        source: location,
                        relationKind: relation.relationKind,
                        confidence: relation.confidence,
                    });
                    incomingRelations.set(relation.targetName, list);
                }
            }
        }

        return {
            definitionsByName,
            incomingRelations,
            relationsBySymbolId,
        };
    }

    private async populateOutgoing(
        node: TypeGraphNode,
        location: DefinitionLocation,
        registry: TypeRegistry,
        depth: number,
        maxDepth: number,
        queue: QueueItem[],
        enqueued: Set<string>,
        visitedNodes: Record<string, TypeGraphNode>
    ): Promise<boolean> {
        let truncated = false;
        const relations = registry.relationsBySymbolId.get(node.symbolId) || this.extractTypeRelations(location.definition);
        for (const relation of relations) {
            const candidates = registry.definitionsByName.get(relation.targetName) || [];
            if (candidates.length === 0) {
                continue;
            }
            for (const candidate of candidates) {
                const targetId = this.makeSymbolId(candidate.relativePath, candidate.definition.name);
                this.definitionCache.set(targetId, candidate);
                const targetNode = this.ensureNode(targetId, candidate, visitedNodes);
                this.connectNodes(node, targetNode, relation.relationKind, relation.confidence);
                if (depth < maxDepth && !enqueued.has(targetId)) {
                    queue.push({ symbolId: targetId, depth: depth + 1 });
                    enqueued.add(targetId);
                } else if (depth >= maxDepth) {
                    truncated = true;
                }
            }
        }
        return truncated;
    }

    private populateIncoming(
        node: TypeGraphNode,
        location: DefinitionLocation,
        registry: TypeRegistry,
        depth: number,
        maxDepth: number,
        queue: QueueItem[],
        enqueued: Set<string>,
        visitedNodes: Record<string, TypeGraphNode>
    ): boolean {
        let truncated = false;
        const incoming = registry.incomingRelations.get(location.definition.name) || [];
        for (const entry of incoming) {
            const parentId = this.makeSymbolId(entry.source.relativePath, entry.source.definition.name);
            if (parentId === node.symbolId) continue;
            this.definitionCache.set(parentId, entry.source);
            const parentNode = this.ensureNode(parentId, entry.source, visitedNodes);
            this.connectNodes(parentNode, node, entry.relationKind, entry.confidence);
            if (depth < maxDepth && !enqueued.has(parentId)) {
                queue.push({ symbolId: parentId, depth: depth + 1 });
                enqueued.add(parentId);
            } else if (depth >= maxDepth) {
                truncated = true;
            }
        }
        return truncated;
    }

    private connectNodes(
        source: TypeGraphNode,
        target: TypeGraphNode,
        relationKind: TypeRelationKind,
        confidence: CallConfidence
    ) {
        if (!source.dependencies.some(edge => edge.toSymbolId === target.symbolId && edge.relationKind === relationKind)) {
            const edge: TypeGraphEdge = {
                fromSymbolId: source.symbolId,
                toSymbolId: target.symbolId,
                relationKind,
                confidence,
            };
            source.dependencies.push(edge);
        }

        if (!target.parents.some(edge => edge.fromSymbolId === source.symbolId && edge.relationKind === relationKind)) {
            const edge: TypeGraphEdge = {
                fromSymbolId: source.symbolId,
                toSymbolId: target.symbolId,
                relationKind,
                confidence,
            };
            target.parents.push(edge);
        }
    }

    private createGraphNode(symbolId: string, location: DefinitionLocation): TypeGraphNode {
        return {
            symbolId,
            symbolName: location.definition.name,
            filePath: location.relativePath,
            symbolType: location.definition.type,
            range: location.definition.range,
            parents: [],
            dependencies: [],
        };
    }

    private ensureNode(symbolId: string, location: DefinitionLocation, visited: Record<string, TypeGraphNode>): TypeGraphNode {
        if (!visited[symbolId]) {
            visited[symbolId] = this.createGraphNode(symbolId, location);
        }
        return visited[symbolId];
    }

    private extractTypeRelations(definition: DefinitionSymbol): TypeRelation[] {
        if (!TYPE_DEFINITION_KINDS.includes(definition.type)) {
            return [];
        }
        const sourceText = definition.signature || definition.content || '';
        if (!sourceText) {
            return [];
        }

        const relations: TypeRelation[] = [];
        if (definition.type === 'class' || definition.type === 'interface') {
            const extendsTargets = this.extractClauseTargets(sourceText, 'extends');
            relations.push(...extendsTargets.map(targetName => ({
                targetName,
                relationKind: 'extends' as TypeRelationKind,
                confidence: 'definite' as CallConfidence,
            })));
        }

        if (definition.type === 'class') {
            const implementTargets = this.extractClauseTargets(sourceText, 'implements');
            relations.push(...implementTargets.map(targetName => ({
                targetName,
                relationKind: 'implements' as TypeRelationKind,
                confidence: 'definite' as CallConfidence,
            })));
        }

        if (definition.type === 'type_alias') {
            const aliasTargets = this.extractAliasTargets(sourceText);
            relations.push(...aliasTargets.map(targetName => ({
                targetName,
                relationKind: 'alias' as TypeRelationKind,
                confidence: 'definite' as CallConfidence,
            })));
        }

        const constraintTargets = this.extractGenericConstraintTargets(sourceText);
        relations.push(...constraintTargets.map(targetName => ({
            targetName,
            relationKind: 'constraint' as TypeRelationKind,
            confidence: 'definite' as CallConfidence,
        })));

        return relations;
    }

    private extractClauseTargets(source: string, keyword: 'extends' | 'implements'): string[] {
        const pattern = new RegExp(`${keyword}\\s+([^\\n\\r]+?)(?=implements|extends|\\{|\/\/|$)`, 'i');
        const match = source.match(pattern);
        if (!match) {
            return [];
        }
        return this.extractIdentifiers(match[1]);
    }

    private extractAliasTargets(source: string): string[] {
        const match = source.match(/=\s*([^;]+)/);
        if (!match) {
            return [];
        }
        return this.extractIdentifiers(match[1]);
    }

    private extractGenericConstraintTargets(source: string): string[] {
        const genericMatch = source.match(/<([^>]*)>/);
        if (!genericMatch) {
            return [];
        }
        const text = genericMatch[1];
        const results: string[] = [];
        const regex = /extends\s+([A-Za-z_][A-Za-z0-9_.$]*)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const candidate = match[1];
            if (!PRIMITIVE_TYPES.has(candidate)) {
                results.push(candidate);
            }
        }
        return results;
    }

    private extractIdentifiers(text: string): string[] {
        const matches = text.match(/[A-Za-z_][A-Za-z0-9_.$]*/g) || [];
        const identifiers: string[] = [];
        for (const candidate of matches) {
            if (STOP_WORDS.has(candidate) || PRIMITIVE_TYPES.has(candidate)) {
                continue;
            }
            identifiers.push(candidate);
        }
        return identifiers;
    }

    private normalizeRelativePath(filePath: string): string {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        return path.relative(this.rootPath, abs);
    }

    private makeSymbolId(relativePath: string, symbolName: string): string {
        return `${relativePath}::${symbolName}`;
    }

    private isTypeDefinition(symbol: SymbolInfo): symbol is DefinitionSymbol {
        return TYPE_DEFINITION_KINDS.includes((symbol as DefinitionSymbol).type as DefinitionSymbol['type']);
    }
}
