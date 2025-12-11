import { SkeletonGenerator } from "../ast/SkeletonGenerator.js";
import { DefinitionSymbol, SemanticChange, SemanticDiffProvider, SemanticDiffSummary, SymbolInfo } from "../types.js";

function toLineRange(symbol: SymbolInfo | DefinitionSymbol | undefined) {
    if (!symbol?.range) {
        return undefined;
    }
    return {
        start: symbol.range.startLine + 1,
        end: symbol.range.endLine + 1,
    };
}

const MIN_RENAME_SIMILARITY = 0.8;

export class AstAwareDiff implements SemanticDiffProvider {
    constructor(private readonly skeletonGenerator: SkeletonGenerator) {}

    public async diff(filePath: string, oldContent: string, newContent: string): Promise<SemanticDiffSummary | undefined> {
        try {
            const [oldSymbols, newSymbols] = await Promise.all([
                this.skeletonGenerator.generateStructureJson(filePath, oldContent).catch(() => []),
                this.skeletonGenerator.generateStructureJson(filePath, newContent).catch(() => []),
            ]);
            const changes = this.computeChanges(oldContent, newContent, oldSymbols, newSymbols);
            const stats = this.computeStats(changes);
            return { changes, stats };
        } catch {
            return undefined;
        }
    }

    private computeChanges(
        oldContent: string,
        newContent: string,
        oldSymbols: SymbolInfo[],
        newSymbols: SymbolInfo[]
    ): SemanticChange[] {
        const changes: SemanticChange[] = [];
        const consumedNew = new Set<number>();
        const definitionOld = oldSymbols.filter(this.isDefinition);
        const definitionNew = newSymbols.filter(this.isDefinition);

        definitionOld.forEach(oldSym => {
            const newIndex = definitionNew.findIndex(
                (sym, idx) =>
                    !consumedNew.has(idx) &&
                    this.isDefinition(sym) &&
                    sym.type === oldSym.type &&
                    sym.name === oldSym.name
            );
            if (newIndex !== -1) {
                const counterpart = definitionNew[newIndex]!;
                consumedNew.add(newIndex);
                this.handleExistingSymbol(changes, oldSym, counterpart, oldContent, newContent);
                return;
            }

            const renameIndex = definitionNew.findIndex((sym, idx) => {
                if (consumedNew.has(idx) || sym.type !== oldSym.type) {
                    return false;
                }
                const similarity = this.computeSimilarity(
                    this.extractBody(oldContent, oldSym),
                    this.extractBody(newContent, sym)
                );
                return similarity >= MIN_RENAME_SIMILARITY;
            });

            if (renameIndex !== -1) {
                const renamed = definitionNew[renameIndex]!;
                consumedNew.add(renameIndex);
                const similarity = this.computeSimilarity(
                    this.extractBody(oldContent, oldSym),
                    this.extractBody(newContent, renamed)
                );
                changes.push({
                    type: "rename",
                    symbolType: renamed.type,
                    name: renamed.name,
                    oldName: oldSym.name,
                    similarity,
                    oldLocation: toLineRange(oldSym),
                    newLocation: toLineRange(renamed),
                });
                return;
            }

            changes.push({
                type: "remove",
                symbolType: oldSym.type,
                name: oldSym.name,
                oldLocation: toLineRange(oldSym),
            });
        });

        definitionNew.forEach((symbol, idx) => {
            if (consumedNew.has(idx)) {
                return;
            }
            changes.push({
                type: "add",
                symbolType: symbol.type,
                name: symbol.name,
                newLocation: toLineRange(symbol),
            });
        });

        return changes;
    }

    private handleExistingSymbol(
        changes: SemanticChange[],
        oldSym: DefinitionSymbol,
        newSym: DefinitionSymbol,
        oldContent: string,
        newContent: string
    ): void {
        const moved = oldSym.range.startLine !== newSym.range.startLine;
        const bodyChanged = !this.isBodyEqual(
            this.extractBody(oldContent, oldSym),
            this.extractBody(newContent, newSym)
        );
        if (!moved && !bodyChanged) {
            return;
        }
        if (moved && !bodyChanged) {
            changes.push({
                type: "move",
                symbolType: newSym.type,
                name: newSym.name,
                oldLocation: toLineRange(oldSym),
                newLocation: toLineRange(newSym),
            });
            return;
        }
        changes.push({
            type: "modify",
            symbolType: newSym.type,
            name: newSym.name,
            oldLocation: toLineRange(oldSym),
            newLocation: toLineRange(newSym),
        });
    }

    private computeStats(changes: SemanticChange[]): SemanticDiffSummary["stats"] {
        return changes.reduce(
            (stats, change) => {
                switch (change.type) {
                    case "add":
                        stats.added += 1;
                        break;
                    case "remove":
                        stats.removed += 1;
                        break;
                    case "modify":
                        stats.modified += 1;
                        break;
                    case "rename":
                        stats.renamed += 1;
                        break;
                    case "move":
                        stats.moved += 1;
                        break;
                }
                return stats;
            },
            { added: 0, removed: 0, modified: 0, renamed: 0, moved: 0 }
        );
    }

    private extractBody(content: string, symbol?: DefinitionSymbol): string {
        if (!symbol?.range) {
            return "";
        }
        const { startByte, endByte } = symbol.range;
        if (startByte === undefined || endByte === undefined) {
            return "";
        }
        return content.substring(startByte, endByte);
    }

    private isBodyEqual(a: string, b: string): boolean {
        return this.normalizeBody(a) === this.normalizeBody(b);
    }

    private computeSimilarity(a: string, b: string): number {
        const tokensA = this.tokenizeBody(a);
        const tokensB = this.tokenizeBody(b);
        if (tokensA.size === 0 && tokensB.size === 0) {
            return 1;
        }
        const intersection = new Set([...tokensA].filter(token => tokensB.has(token)));
        const union = new Set([...tokensA, ...tokensB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
    }

    private tokenizeBody(body: string): Set<string> {
        return new Set(this.normalizeBody(body).split(/\s+/).filter(Boolean));
    }

    private normalizeBody(body: string): string {
        return body
            .replace(/\/\/.*$/gm, "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    private isDefinition(symbol: SymbolInfo): symbol is DefinitionSymbol {
        return symbol.type !== "import" && symbol.type !== "export";
    }
}
