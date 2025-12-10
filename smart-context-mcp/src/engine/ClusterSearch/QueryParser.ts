import { SymbolInfo } from "../../types.js";

export type QueryIntent = "definition" | "usage" | "related" | "any";

export interface QueryFilters {
    type?: SymbolInfo["type"][];
    file?: string;
    scope?: "local" | "project";
}

export interface ParsedQuery {
    terms: string[];
    filters: QueryFilters;
    intent: QueryIntent;
}

export class QueryParser {
    parse(query: string): ParsedQuery {
        const trimmed = query.trim();
        const filters: QueryFilters = {};
        const terms: string[] = [];
        let intent: QueryIntent = "any";

        if (!trimmed) {
            return { terms, filters, intent };
        }

        const tokens = trimmed.split(/\s+/);
        for (const token of tokens) {
            if (token.startsWith("function:")) {
                filters.type = [...(filters.type || []), "function", "method"];
                const remainder = token.slice("function:".length);
                if (remainder) terms.push(remainder);
                continue;
            }
            if (token.startsWith("class:")) {
                filters.type = [...(filters.type || []), "class"];
                const remainder = token.slice("class:".length);
                if (remainder) terms.push(remainder);
                continue;
            }
            if (token.startsWith("in:")) {
                filters.file = token.slice(3);
                continue;
            }
            if (token.startsWith("scope:")) {
                const scope = token.slice(6);
                if (scope === "local" || scope === "project") {
                    filters.scope = scope;
                }
                continue;
            }
            if (token.startsWith("usages:")) {
                intent = "usage";
                const remainder = token.slice("usages:".length);
                if (remainder) terms.push(remainder);
                continue;
            }

            terms.push(token);
        }

        return { terms: terms.filter(Boolean), filters, intent };
    }
}
