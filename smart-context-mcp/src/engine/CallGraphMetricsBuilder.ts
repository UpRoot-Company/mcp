import { CallGraphBuilder } from "../ast/CallGraphBuilder.js";

export interface CallGraphSignals {
    symbolId: string;
    depth: number;
    inDegree: number;
    outDegree: number;
    isEntryPoint: boolean;
    pageRank?: number;
}

export class CallGraphMetricsBuilder {
    constructor(private readonly callGraphBuilder: CallGraphBuilder) {}

    public async buildMetrics(
        entrySymbols: Array<{ symbolName: string; filePath: string }>
    ): Promise<Map<string, CallGraphSignals>> {
        const signals = new Map<string, CallGraphSignals>();

        for (const entry of entrySymbols) {
            const graph = await this.callGraphBuilder.analyzeSymbol(entry.symbolName, entry.filePath, "both", 5);
            if (!graph) {
                continue;
            }

            const queue: Array<{ symbolId: string; depth: number }> = [
                { symbolId: graph.root.symbolId, depth: 0 }
            ];
            const visited = new Set<string>();

            while (queue.length > 0) {
                const { symbolId, depth } = queue.shift()!;
                if (visited.has(symbolId)) {
                    continue;
                }
                visited.add(symbolId);
                const node = graph.visitedNodes[symbolId];
                if (!node) {
                    continue;
                }

                signals.set(symbolId, {
                    symbolId,
                    depth,
                    inDegree: node.callers.length,
                    outDegree: node.callees.length,
                    isEntryPoint: symbolId === graph.root.symbolId
                });

                for (const caller of node.callers) {
                    queue.push({ symbolId: caller.fromSymbolId, depth: depth + 1 });
                }
                for (const callee of node.callees) {
                    queue.push({ symbolId: callee.toSymbolId, depth: depth + 1 });
                }
            }

            const ranks = this.computePageRank(graph.visitedNodes);
            for (const [id, rank] of ranks.entries()) {
                const existing = signals.get(id);
                if (existing) {
                    existing.pageRank = Math.max(existing.pageRank ?? 0, rank);
                }
            }
        }

        return signals;
    }

    private computePageRank(nodes: Record<string, { callees: Array<{ toSymbolId: string }> }>): Map<string, number> {
        const damping = 0.85;
        const ids = Object.keys(nodes);
        const n = ids.length;
        if (n === 0) {
            return new Map();
        }

        const outgoing = new Map<string, string[]>();
        for (const id of ids) {
            const node = nodes[id];
            outgoing.set(id, node.callees.map(edge => edge.toSymbolId).filter(Boolean));
        }

        let ranks = new Map<string, number>(ids.map(id => [id, 1 / n]));
        for (let iter = 0; iter < 20; iter++) {
            const next = new Map<string, number>();
            for (const id of ids) {
                next.set(id, (1 - damping) / n);
            }
            for (const id of ids) {
                const outs = outgoing.get(id) ?? [];
                const share = (ranks.get(id) ?? 0) / (outs.length || n);
                if (outs.length === 0) {
                    for (const other of ids) {
                        next.set(other, (next.get(other) ?? 0) + damping * share);
                    }
                } else {
                    for (const to of outs) {
                        if (!next.has(to)) continue;
                        next.set(to, (next.get(to) ?? 0) + damping * share);
                    }
                }
            }
            ranks = next;
        }

        return ranks;
    }
}
