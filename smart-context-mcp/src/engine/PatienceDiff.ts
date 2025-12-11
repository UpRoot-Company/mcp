type DiffType = "equal" | "insert" | "delete" | "replace";

export interface DiffHunk {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    type: DiffType;
    oldLines: string[];
    newLines: string[];
}

export interface DiffOptions {
    ignoreWhitespace?: boolean;
    contextLines?: number;
    semantic?: boolean;
}

const DEFAULT_CONTEXT_LINES = 3;

export class PatienceDiff {
    /**
     * Compute Patience diff hunks between two text buffers.
     * Anchors unique lines, falls back to Myers-style replacements for tough gaps.
     */
    static diff(oldText: string, newText: string, options: DiffOptions = {}): DiffHunk[] {
        const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
        const oldLines = oldText.split("\n");
        const newLines = newText.split("\n");

        const normalizedOld = options.ignoreWhitespace
            ? oldLines.map((line) => line.trim())
            : oldLines;
        const normalizedNew = options.ignoreWhitespace
            ? newLines.map((line) => line.trim())
            : newLines;

        const uniqueMatches = this.findUniqueMatches(normalizedOld, normalizedNew);
        const lis = this.longestIncreasingSubsequence(uniqueMatches);
        const hunks = this.buildHunks(oldLines, newLines, lis, contextLines);

        if (options.semantic) {
            return this.semanticGroup(hunks);
        }

        return hunks;
    }

    /**
     * Render a unified diff string from hunks.
     */
    static formatUnified(hunks: DiffHunk[]): string {
        return hunks
            .map((hunk) => {
                const header = `@@ -${hunk.oldStart + 1},${hunk.oldEnd - hunk.oldStart} +${
                    hunk.newStart + 1
                },${hunk.newEnd - hunk.newStart} @@`;
                const payload: string[] = [header];
                switch (hunk.type) {
                    case "equal":
                        payload.push(...hunk.oldLines.map((line) => ` ${line}`));
                        break;
                    case "delete":
                        payload.push(...hunk.oldLines.map((line) => `-${line}`));
                        break;
                    case "insert":
                        payload.push(...hunk.newLines.map((line) => `+${line}`));
                        break;
                    case "replace":
                        payload.push(...hunk.oldLines.map((line) => `-${line}`));
                        payload.push(...hunk.newLines.map((line) => `+${line}`));
                        break;
                }
                return payload.join("\n");
            })
            .join("\n");
    }

    /**
     * Summaries lines added/removed/changed across all hunks.
     */
    static summarize(hunks: DiffHunk[]): { added: number; removed: number; changed: number } {
        let added = 0;
        let removed = 0;
        let changed = 0;

        for (const hunk of hunks) {
            switch (hunk.type) {
                case "insert":
                    added += hunk.newLines.length;
                    break;
                case "delete":
                    removed += hunk.oldLines.length;
                    break;
                case "replace":
                    added += hunk.newLines.length;
                    removed += hunk.oldLines.length;
                    changed += Math.max(hunk.oldLines.length, hunk.newLines.length);
                    break;
                default:
                    break;
            }
        }

        return { added, removed, changed };
    }

    private static findUniqueMatches(
        oldLines: string[],
        newLines: string[]
    ): Array<{ oldIndex: number; newIndex: number }> {
        const oldCounts = new Map<string, { count: number; index: number }>();
        const newCounts = new Map<string, { count: number; index: number }>();

        oldLines.forEach((line, idx) => {
            const info = oldCounts.get(line);
            if (info) {
                info.count += 1;
            } else {
                oldCounts.set(line, { count: 1, index: idx });
            }
        });

        newLines.forEach((line, idx) => {
            const info = newCounts.get(line);
            if (info) {
                info.count += 1;
            } else {
                newCounts.set(line, { count: 1, index: idx });
            }
        });

        const matches: Array<{ oldIndex: number; newIndex: number }> = [];
        for (const [line, oldInfo] of oldCounts) {
            if (oldInfo.count !== 1) continue;
            const newInfo = newCounts.get(line);
            if (!newInfo || newInfo.count !== 1) continue;
            matches.push({ oldIndex: oldInfo.index, newIndex: newInfo.index });
        }

        return matches.sort((a, b) => a.oldIndex - b.oldIndex);
    }

    private static longestIncreasingSubsequence(
        matches: Array<{ oldIndex: number; newIndex: number }>
    ): Array<{ oldIndex: number; newIndex: number }> {
        if (matches.length === 0) {
            return [];
        }

        const parent = new Array(matches.length).fill(-1);
        const dp = new Array(matches.length).fill(1);

        for (let i = 1; i < matches.length; i++) {
            for (let j = 0; j < i; j++) {
                if (matches[j].newIndex < matches[i].newIndex && dp[j] + 1 > dp[i]) {
                    dp[i] = dp[j] + 1;
                    parent[i] = j;
                }
            }
        }

        let maxLen = 0;
        let maxIdx = 0;
        for (let i = 0; i < dp.length; i++) {
            if (dp[i] > maxLen) {
                maxLen = dp[i];
                maxIdx = i;
            }
        }

        const result: Array<{ oldIndex: number; newIndex: number }> = [];
        let idx: number | null = maxIdx;
        while (idx !== null && idx !== -1) {
            result.unshift(matches[idx]);
            idx = parent[idx];
        }

        return result;
    }

    private static buildHunks(
        oldLines: string[],
        newLines: string[],
        anchors: Array<{ oldIndex: number; newIndex: number }>,
        contextLines: number
    ): DiffHunk[] {
        const hunks: DiffHunk[] = [];
        let oldPos = 0;
        let newPos = 0;

        for (const anchor of anchors) {
            if (oldPos < anchor.oldIndex || newPos < anchor.newIndex) {
                hunks.push(
                    ...this.processGap(
                        oldLines,
                        newLines,
                        oldPos,
                        anchor.oldIndex,
                        newPos,
                        anchor.newIndex,
                        contextLines
                    )
                );
            }

            hunks.push({
                oldStart: anchor.oldIndex,
                oldEnd: anchor.oldIndex + 1,
                newStart: anchor.newIndex,
                newEnd: anchor.newIndex + 1,
                type: "equal",
                oldLines: [oldLines[anchor.oldIndex]],
                newLines: [newLines[anchor.newIndex]],
            });

            oldPos = anchor.oldIndex + 1;
            newPos = anchor.newIndex + 1;
        }

        if (oldPos < oldLines.length || newPos < newLines.length) {
            hunks.push(
                ...this.processGap(
                    oldLines,
                    newLines,
                    oldPos,
                    oldLines.length,
                    newPos,
                    newLines.length,
                    contextLines
                )
            );
        }

        return this.mergeAdjacentHunks(hunks, contextLines);
    }

    private static processGap(
        oldLines: string[],
        newLines: string[],
        oldStart: number,
        oldEnd: number,
        newStart: number,
        newEnd: number,
        contextLines: number
    ): DiffHunk[] {
        const oldSlice = oldLines.slice(oldStart, oldEnd);
        const newSlice = newLines.slice(newStart, newEnd);

        if (oldSlice.length === 0 && newSlice.length === 0) {
            return [];
        }

        if (oldSlice.length === 0) {
            return [
                {
                    oldStart,
                    oldEnd,
                    newStart,
                    newEnd,
                    type: "insert",
                    oldLines: [],
                    newLines: newSlice,
                },
            ];
        }

        if (newSlice.length === 0) {
            return [
                {
                    oldStart,
                    oldEnd,
                    newStart,
                    newEnd,
                    type: "delete",
                    oldLines: oldSlice,
                    newLines: [],
                },
            ];
        }

        if (oldSlice.length <= 3 && newSlice.length <= 3) {
            return [
                {
                    oldStart,
                    oldEnd,
                    newStart,
                    newEnd,
                    type: "replace",
                    oldLines: oldSlice,
                    newLines: newSlice,
                },
            ];
        }

        const subMatches = this.findUniqueMatches(oldSlice, newSlice);
        if (subMatches.length === 0) {
            return [
                {
                    oldStart,
                    oldEnd,
                    newStart,
                    newEnd,
                    type: "replace",
                    oldLines: oldSlice,
                    newLines: newSlice,
                },
            ];
        }

        const adjusted = subMatches.map((match) => ({
            oldIndex: match.oldIndex + oldStart,
            newIndex: match.newIndex + newStart,
        }));

        const subLis = this.longestIncreasingSubsequence(adjusted);
        return this.buildHunks(oldLines, newLines, subLis, contextLines);
    }

    private static mergeAdjacentHunks(hunks: DiffHunk[], contextLines: number): DiffHunk[] {
        if (hunks.length === 0) {
            return [];
        }

        const merged: DiffHunk[] = [];
        let current = hunks[0];

        for (let i = 1; i < hunks.length; i++) {
            const next = hunks[i];
            if (
                current.type === "equal" &&
                next.type === "equal" &&
                current.oldEnd === next.oldStart &&
                current.newEnd === next.newStart
            ) {
                current = {
                    ...current,
                    oldEnd: next.oldEnd,
                    newEnd: next.newEnd,
                    oldLines: current.oldLines.concat(next.oldLines),
                    newLines: current.newLines.concat(next.newLines),
                };
                continue;
            }

            merged.push(current);
            current = next;
        }
        merged.push(current);

        return merged;
    }

    private static semanticGroup(hunks: DiffHunk[]): DiffHunk[] {
        if (hunks.length < 2) {
            return hunks;
        }

        const grouped: DiffHunk[] = [];
        let idx = 0;
        while (idx < hunks.length) {
            const current = hunks[idx];
            const next = hunks[idx + 1];

            if (
                current &&
                next &&
                current.type === "delete" &&
                next.type === "insert" &&
                this.normalizeLines(current.oldLines).join("\n") ===
                    this.normalizeLines(next.newLines).join("\n")
            ) {
                grouped.push({
                    oldStart: current.oldStart,
                    oldEnd: current.oldEnd,
                    newStart: next.newStart,
                    newEnd: next.newEnd,
                    type: "replace",
                    oldLines: current.oldLines,
                    newLines: next.newLines,
                });
                idx += 2;
                continue;
            }

            grouped.push(current);
            idx += 1;
        }

        return grouped;
    }

    private static normalizeLines(lines: string[]): string[] {
        return lines.map((line) => line.trim());
    }
}
