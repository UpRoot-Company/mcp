import path from 'path';
import { FileSearchResult } from '../../types.js';

export class ResultProcessor {
    public postProcessResults(
        results: FileSearchResult[],
        options: {
            fileTypes?: string[];
            snippetLength: number;
            groupByFile?: boolean;
            deduplicateByContent?: boolean;
        }
    ): FileSearchResult[] {
        let processed = this.filterByFileType(results, options.fileTypes);

        if (options.deduplicateByContent) {
            processed = this.deduplicateByContent(processed);
        }

        processed = this.applySnippetLength(processed, options.snippetLength);

        if (options.groupByFile) {
            processed = this.groupResultsByFile(processed);
        }

        return processed;
    }

    private filterByFileType(results: FileSearchResult[], fileTypes?: string[]): FileSearchResult[] {
        if (!fileTypes || fileTypes.length === 0) {
            return results;
        }
        const normalized = new Set(fileTypes.map(ext => ext.replace(/^\./, "").toLowerCase()));
        return results.filter(result => {
            const fileExt = path.extname(result.filePath).replace(".", "").toLowerCase();
            return fileExt ? normalized.has(fileExt) : false;
        });
    }

    private applySnippetLength(results: FileSearchResult[], snippetLength: number): FileSearchResult[] {
        if (snippetLength <= 0) {
            return results.map(result => ({ ...result, preview: "" }));
        }
        return results.map(result => {
            if (!result.preview || result.preview.length <= snippetLength) {
                return result;
            }
            const sliceLength = Math.max(1, snippetLength - 1);
            return {
                ...result,
                preview: `${result.preview.slice(0, sliceLength)}…`
            };
        });
    }

    private deduplicateByContent(results: FileSearchResult[]): FileSearchResult[] {
        const seen = new Set<string>();
        const deduped: FileSearchResult[] = [];
        for (const result of results) {
            const fallback = `${result.filePath}:${result.lineNumber}`;
            const key = result.preview?.length ? result.preview : fallback;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduped.push(result);
        }
        return deduped;
    }

    private groupResultsByFile(results: FileSearchResult[]): FileSearchResult[] {
        const grouped = new Map<string, FileSearchResult[]>();
        const order: string[] = [];
        for (const result of results) {
            if (!grouped.has(result.filePath)) {
                grouped.set(result.filePath, []);
                order.push(result.filePath);
            }
            grouped.get(result.filePath)!.push(result);
        }

        return order.map(filePath => {
            const matches = grouped.get(filePath)!;
            const sorted = matches.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            const primary = { ...sorted[0] };
            primary.groupedMatches = sorted.map(match => ({
                lineNumber: match.lineNumber,
                preview: match.preview,
                score: match.score,
                scoreDetails: match.scoreDetails
            }));
            primary.matchCount = sorted.length;
            return primary;
        });
    }
}
