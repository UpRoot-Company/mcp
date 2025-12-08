import * as fs from "fs";
import { promisify } from "util";
import * as path from "path";
import * as crypto from "crypto";
import { MyersDiff } from "./Diff.js";
import * as levenshtein from "fast-levenshtein";
import { Edit, EditOperation, EditResult, LineRange } from "../types.js";
import { LineCounter } from "./LineCounter.js";

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const readdirAsync = promisify(fs.readdir);
const unlinkAsync = promisify(fs.unlink);

interface Match {
    start: number;
    end: number;
    replacement: string;
    original: string;
    lineNumber: number;
}

export class AmbiguousMatchError extends Error {
    public conflictingLines: number[];

    constructor(message: string, details: { conflictingLines: number[] }) {
        super(message);
        this.name = "AmbiguousMatchError";
        this.conflictingLines = details.conflictingLines;
    }
}

export class EditorEngine {
    private rootPath: string;
    private backupsDir: string;

    constructor(rootPath: string) {
        this.rootPath = rootPath;
        this.backupsDir = path.join(rootPath, ".mcp", "backups");
        this._ensureBackupsDirExists();
    }

    private _ensureBackupsDirExists(): void {
        if (!fs.existsSync(this.backupsDir)) {
            fs.mkdirSync(this.backupsDir, { recursive: true });
        }
    }

    private _getBackupFilePath(originalFilePath: string): string {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.-]/g, "");
        const encodedPath = originalFilePath
            .replace(/^[A-Z]:/i, (drive) => drive[0] + "_")
            .replace(/["\/\\:]/g, "_")
            .replace(/^_/, "");
        return path.join(this.backupsDir, `${encodedPath}_${timestamp}.bak`);
    }

    private async _createTimestampedBackup(originalFilePath: string, content: string): Promise<void> {
        const backupPath = this._getBackupFilePath(originalFilePath);
        await writeFileAsync(backupPath, content);
    }

    private async _enforceRetentionPolicy(originalFilePath: string, maxBackups: number = 10): Promise<void> {
        try {
            const encodedPathPrefix = originalFilePath
                .replace(/^[A-Z]:/i, (drive) => drive[0] + "_")
                .replace(/["\/\\:]/g, "_")
                .replace(/^_/, "");

            const files = await readdirAsync(this.backupsDir);
            const relevantBackups = files
                .filter((f) => f.startsWith(`${encodedPathPrefix}_`) && f.endsWith(".bak"))
                .sort((a, b) => b.localeCompare(a));

            if (relevantBackups.length > maxBackups) {
                const toDelete = relevantBackups.slice(maxBackups);
                for (const file of toDelete) {
                    await unlinkAsync(path.join(this.backupsDir, file));
                }
            }
        } catch (error: any) {
            console.warn(`[EditorEngine] Failed to enforce backup retention: ${error.message}`);
        }
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private createBoundaryPattern(target: string): string {
        const needsStartBoundary = /^[a-zA-Z0-9_]/.test(target);
        const needsEndBoundary = /[a-zA-Z0-9_]$/.test(target);
        const escaped = this.escapeRegExp(target);
        
        const supportsLookbehind = (() => { try { new RegExp('(?<=a)'); return true; } catch { return false; } })();

        let pattern = escaped;
        if (needsStartBoundary) {
            pattern = supportsLookbehind ? `(?<![a-zA-Z0-9_])${pattern}` : `\\b${pattern}`;
        }
        if (needsEndBoundary) {
            pattern = `${pattern}(?![a-zA-Z0-9_])`;
        }
        return pattern;
    }

    private createExactRegex(target: string): RegExp {
        const pattern = this.createBoundaryPattern(target);
        return new RegExp(pattern, "g");
    }

    private createFuzzyRegex(target: string): RegExp {
        const escaped = this.escapeRegExp(target);
        const words = escaped.split(/\s+/).filter((word) => word.length > 0);

        if (words.length === 0) {
            return this.createExactRegex(target);
        }

        const corePattern = words.join("\\s+");
        
        const needsStart = /^[a-zA-Z0-9_]/.test(words[0]);
        const needsEnd = /[a-zA-Z0-9_]$/.test(words[words.length - 1]);
        
        const supportsLookbehind = (() => { try { new RegExp('(?<=a)'); return true; } catch { return false; } })();
        
        let finalPattern = corePattern;
        if (needsStart) {
             finalPattern = supportsLookbehind ? `(?<![a-zA-Z0-9_])${finalPattern}` : `\\b${finalPattern}`;
        }
        if (needsEnd) {
            finalPattern = `${finalPattern}(?![a-zA-Z0-9_])`;
        }
        
        return new RegExp(finalPattern, "g");
    }

    private isBoundaryPosition(content: string, index: number): boolean {
        if (index === 0) return true;
        const prev = content[index - 1];
        const curr = content[index];
        return /\s/.test(prev) && !/\s/.test(curr); 
    }

    private findLevenshteinCandidates(
        content: string, 
        target: string, 
        replacement: string,
        lineCounter: LineCounter,
        lineRange?: LineRange
    ): Match[] {
        const targetLen = target.length;
        if (targetLen >= 256) {
             throw new Error(`Target string for Levenshtein fuzzy matching exceeds 256 characters.`);
        }

        const tolerance = Math.floor(targetLen * 0.3); // 30% threshold
        const windowSize = targetLen + tolerance;
        const candidates: { start: number; end: number; distance: number; original: string }[] = [];
        
        // Optimize: scan only relevant range if lineRange provided
        // But LineCounter doesn't support reverse lookup (line -> index).
        // Actually, we can just iterate index and check line number? 
        // No, that's O(N log N).
        // Ideally we need line->index lookup. 
        // For now, let's scan full content but filter by line number efficiently.
        // Or just scan full content.
        
        const MAX_OPS = 1000000;
        let ops = 0;

        for (let i = 0; i <= content.length - targetLen; i++) {
            ops++;
            if (ops > MAX_OPS) {
                throw new Error("Fuzzy search timed out (exceeded max operations). Please refine your search.");
            }

            // Boundary optimization: Only start matching at word boundaries
            // This reduces the number of expensive Levenshtein calls
            if (!this.isBoundaryPosition(content, i)) continue;

            const windowEnd = Math.min(i + windowSize, content.length);
            const window = content.substring(i, windowEnd);

            for (let len = targetLen - tolerance; len <= targetLen + tolerance; len++) {
                if (len <= 0 || len > window.length) continue;
                const candidateStr = window.substring(0, len);
                const distance = levenshtein.get(target, candidateStr);

                if (distance <= tolerance) {
                    candidates.push({
                        start: i,
                        end: i + len,
                        distance,
                        original: candidateStr
                    });
                    // If we found a good match at this position, we might want to skip minor variations?
                    // But we'll dedupe later.
                }
            }
        }

        // Deduplicate
        candidates.sort((a, b) => a.distance - b.distance || a.start - b.start);
        const uniqueMatches: Match[] = [];
        
        for (const cand of candidates) {
            const isOverlapping = uniqueMatches.some(m => 
                (cand.start >= m.start && cand.start < m.end) || 
                (cand.end > m.start && cand.end <= m.end)
            );
            
            if (!isOverlapping) {
                // Check context/lineRange filters here?
                // For now, return all, filter in findMatch
                const lineNumber = lineCounter.getLineNumber(cand.start);
                
                if (lineRange) {
                    if (lineNumber < lineRange.start || lineNumber > lineRange.end) continue;
                }

                uniqueMatches.push({
                    start: cand.start,
                    end: cand.end,
                    replacement,
                    original: cand.original,
                    lineNumber
                });
            }
        }

        return uniqueMatches;
    }

    private findMatch(content: string, edit: Edit, lineCounter: LineCounter): Match {
        let matches: Match[] = [];

        if (edit.fuzzyMode === "levenshtein") {
             // Try exact match first
             const exactRegex = this.createExactRegex(edit.targetString);
             const exactMatches = [...content.matchAll(exactRegex)].map(m => ({
                 start: m.index!,
                 end: m.index! + m[0].length,
                 replacement: edit.replacementString,
                 original: m[0],
                 lineNumber: lineCounter.getLineNumber(m.index!)
             }));

             if (exactMatches.length > 0) {
                 matches = exactMatches;
             } else {
                 // Fallback to sliding window
                 matches = this.findLevenshteinCandidates(content, edit.targetString, edit.replacementString, lineCounter, edit.lineRange);
             }
        } else {
            let regex: RegExp;
            if (edit.fuzzyMode === "whitespace") {
                regex = this.createFuzzyRegex(edit.targetString);
            } else {
                regex = this.createExactRegex(edit.targetString);
            }
            matches = [...content.matchAll(regex)].map(m => ({
                start: m.index!,
                end: m.index! + m[0].length,
                replacement: edit.replacementString,
                original: m[0],
                lineNumber: lineCounter.getLineNumber(m.index!)
            }));
        }

        // Filter matches
        const filteredMatches = matches.filter(match => {
            if (edit.lineRange) {
                if (match.lineNumber < edit.lineRange.start || match.lineNumber > edit.lineRange.end) return false;
            }

            if (edit.beforeContext) {
                const searchStart = edit.anchorSearchRange?.chars
                    ? Math.max(0, match.start - edit.anchorSearchRange.chars)
                    : 0;
                const preceding = content.substring(searchStart, match.start);
                if (edit.fuzzyMode === "whitespace") {
                    if (!preceding.replace(/\s+/g, " ").includes(edit.beforeContext.replace(/\s+/g, " "))) {
                        return false;
                    }
                } else {
                    if (!preceding.includes(edit.beforeContext)) return false;
                }
            }

            if (edit.afterContext) {
                const searchEnd = edit.anchorSearchRange?.chars
                    ? Math.min(content.length, match.end + edit.anchorSearchRange.chars)
                    : content.length;
                const following = content.substring(match.end, searchEnd);
                if (edit.fuzzyMode === "whitespace") {
                    if (!following.replace(/\s+/g, " ").includes(edit.afterContext.replace(/\s+/g, " "))) {
                        return false;
                    }
                } else {
                    if (!following.includes(edit.afterContext)) return false;
                }
            }
            return true;
        });

        if (filteredMatches.length === 0) {
            throw new Error(`Target not found: "${edit.targetString}"`);
        }
        if (filteredMatches.length > 1) {
            const conflictingLines = filteredMatches.map(m => m.lineNumber);
            throw new AmbiguousMatchError(
                `Ambiguous match for "${edit.targetString}". Found ${filteredMatches.length} occurrences.`,
                { conflictingLines }
            );
        }

        return filteredMatches[0];
    }

    private applyEditsInternal(originalContent: string, edits: Edit[]): Match[] {
        const lineCounter = new LineCounter(originalContent);
        const plannedMatches: Match[] = [];

        for (const edit of edits) {
            if (edit.indexRange) {
                const { start, end } = edit.indexRange;

                if (start < 0 || end < start || end > originalContent.length) {
                    throw new Error(
                        `Index range [${start}, ${end}) is out of bounds for file of length ${originalContent.length}.`
                    );
                }

                const existing = originalContent.substring(start, end);
                if (existing !== edit.targetString) {
                    throw new Error(
                        `Content mismatch at index range [${start}, ${end}): expected "${edit.targetString}", found "${existing}".`
                    );
                }

                plannedMatches.push({
                    start,
                    end,
                    replacement: edit.replacementString,
                    original: existing,
                    lineNumber: lineCounter.getLineNumber(start),
                });
            } else {
                const match = this.findMatch(originalContent, edit, lineCounter);
                plannedMatches.push(match);
            }
        }

        plannedMatches.sort((a, b) => a.start - b.start);

        for (let i = 0; i < plannedMatches.length - 1; i++) {
            if (plannedMatches[i].end > plannedMatches[i + 1].start) {
                throw new Error(
                    `Conflict detected: Edit for "${plannedMatches[i].original}" (chars ${plannedMatches[i].start}-${plannedMatches[i].end}) overlaps with "${plannedMatches[i + 1].original}" (chars ${plannedMatches[i + 1].start}-${plannedMatches[i + 1].end}).`
                );
            }
        }

        return plannedMatches;
    }

    public async applyEdits(
        filePath: string,
        edits: Edit[],
        dryRun: boolean = false
    ): Promise<EditResult> {
        if (!fs.existsSync(filePath)) {
            return { success: false, message: `File not found: ${filePath}` };
        }

        const originalContent = await readFileAsync(filePath, "utf-8");
        let plannedMatches: Match[];

        try {
            plannedMatches = this.applyEditsInternal(originalContent, edits);
        } catch (error: any) {
            if (error instanceof AmbiguousMatchError) {
                return {
                    success: false,
                    message: error.message,
                    details: { conflictingLines: error.conflictingLines },
                    suggestion:
                        `Ambiguity detected. Refine your request by adding a 'lineRange' parameter to specify which occurrence to target. Conflicting lines are: ${error.conflictingLines.join(", ")}.`,
                    errorCode: "AmbiguousMatch",
                };
            }
            return { success: false, message: error.message };
        }

        let newContent = "";
        let lastCursor = 0;
        const inverseEdits: Edit[] = [];

        for (const match of plannedMatches) {
            const unchanged = originalContent.substring(lastCursor, match.start);
            newContent += unchanged;

            const newStart = newContent.length;
            newContent += match.replacement;
            const newEnd = newStart + match.replacement.length;

            inverseEdits.push({
                targetString: match.replacement,
                replacementString: match.original,
                indexRange: { start: newStart, end: newEnd },
            });

            lastCursor = match.end;
        }
        newContent += originalContent.substring(lastCursor);

        const operation: EditOperation = {
            id:
                typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random()}`,
            timestamp: Date.now(),
            description: `Applied ${edits.length} edits to ${filePath}`,
            edits,
            inverseEdits,
        };

        if (dryRun) {
            const diffSummary = MyersDiff.diffLinesStructured(originalContent, newContent);
            const relativePath = path.relative(this.rootPath, filePath);
            return {
                success: true,
                originalContent,
                newContent,
                diff: diffSummary.diff,
                structuredDiff: [{
                    filePath: relativePath,
                    diff: diffSummary.diff,
                    added: diffSummary.added,
                    removed: diffSummary.removed
                }],
                operation
            };
        }

        const relativePath = path.relative(this.rootPath, filePath);
        await this._createTimestampedBackup(relativePath, originalContent);
        await this._enforceRetentionPolicy(relativePath);
        await writeFileAsync(filePath, newContent);

        return {
            success: true,
            message: `Successfully applied ${edits.length} edits.`,
            operation: {
                ...operation,
                filePath: relativePath,
            },
        };
    }
}
