import * as path from "path";
import * as crypto from "crypto";
import { createRequire } from "module";
import { MyersDiff } from "./Diff.js";
import { PatienceDiff } from "./PatienceDiff.js";
import levenshtein from "fast-levenshtein";
import { DiffMode, Edit, EditOperation, EditResult, LineRange, MatchDiagnostics, ToolSuggestion, SemanticDiffProvider, SemanticDiffSummary } from "../types.js";
import { LineCounter } from "./LineCounter.js";
import { IFileSystem } from "../platform/FileSystem.js";
import { TrigramIndex } from "./TrigramIndex.js";
const require = createRequire(import.meta.url);
let importedXxhash: any = null;
try {
    importedXxhash = require('xxhashjs');
} catch {
    importedXxhash = null;
}
const XXH: any = importedXxhash ? ((importedXxhash as any).default ?? importedXxhash) : null;

interface Match {
    start: number;
    end: number;
    replacement: string;
    original: string;
    lineNumber: number;
    confidence?: number;
    matchType?: 'exact' | 'whitespace-fuzzy' | 'levenshtein' | 'normalization';
}

type NormalizationLevel = "exact" | "whitespace" | "structural";

export class AmbiguousMatchError extends Error {
    public conflictingLines: number[];

    constructor(message: string, details: { conflictingLines: number[] }) {
        super(message);
        this.name = "AmbiguousMatchError";
        this.conflictingLines = details.conflictingLines;
    }
}

export class HashMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HashMismatchError";
    }
}

export class MatchNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MatchNotFoundError";
    }
}

interface ApplyEditsOptions {
    diffMode?: DiffMode;
}

export class EditorEngine {
    private rootPath: string;
    private backupsDir: string;
    private readonly fileSystem: IFileSystem;
    private readonly semanticDiffProvider?: SemanticDiffProvider;

    constructor(rootPath: string, fileSystem: IFileSystem, semanticDiffProvider?: SemanticDiffProvider) {
        this.rootPath = rootPath;
        this.backupsDir = path.join(rootPath, ".mcp", "backups");
        this.fileSystem = fileSystem;
        this.semanticDiffProvider = semanticDiffProvider;
    }

    private async ensureBackupsDirExists(): Promise<void> {
        if (!(await this.fileSystem.exists(this.backupsDir))) {
            await this.fileSystem.createDir(this.backupsDir);
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
        await this.ensureBackupsDirExists();
        await this.fileSystem.writeFile(backupPath, content);
    }

    private async _enforceRetentionPolicy(originalFilePath: string, maxBackups: number = 10): Promise<void> {
        try {
            const encodedPathPrefix = originalFilePath
                .replace(/^[A-Z]:/i, (drive) => drive[0] + "_")
                .replace(/["\/\\:]/g, "_")
                .replace(/^_/, "");

            await this.ensureBackupsDirExists();
            const files = await this.fileSystem.readDir(this.backupsDir);
            const relevantBackups = files
                .filter((f) => f.startsWith(`${encodedPathPrefix}_`) && f.endsWith(".bak"))
                .sort((a, b) => b.localeCompare(a));

            if (relevantBackups.length > maxBackups) {
                const toDelete = relevantBackups.slice(maxBackups);
                for (const file of toDelete) {
                    await this.fileSystem.deleteFile(path.join(this.backupsDir, file));
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

    private trigramKeys(value: string): Set<string> {
        return new Set(TrigramIndex.extractTrigramCounts(value).keys());
    }

    private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
        if (a.size === 0 && b.size === 0) {
            return 1;
        }
        let intersection = 0;
        for (const token of a) {
            if (b.has(token)) {
                intersection++;
            }
        }
        const union = a.size + b.size - intersection;
        if (union === 0) {
            return 0;
        }
        return intersection / union;
    }

    private normalizeString(str: string, level: NormalizationLevel): string {
        if (level === "exact") return str;
        
        let normalized = str;
        
        // Whitespace level: CRLF -> LF, trim trailing lines
        if (level === "whitespace" || level === "structural") {
            normalized = normalized.replace(/\r\n/g, '\n');
            normalized = normalized.split('\n').map(line => line.trimEnd()).join('\n');
        }

        // Structural level: Normalize indentation to single spaces, collapse internal spacing
        if (level === "structural") {
            normalized = normalized.split('\n')
                .map(line => line.trim()) // Ignore indentation completely
                .filter(line => line.length > 0) // Ignore empty lines
                .join('\n');
            // Collapse internal whitespace sequences to single space
            normalized = normalized.replace(/\s+/g, ' ');
        }

        return normalized;
    }

    private getNormalizationAttempts(level?: NormalizationLevel): NormalizationLevel[] {
        if (!level || level === "exact") {
            return ["exact"];
        }
        if (level === "whitespace") {
            return ["exact", "whitespace"];
        }
        return ["exact", "whitespace", "structural"];
    }

    private createExactRegex(target: string, normalization: NormalizationLevel = "exact"): RegExp {
        const normalizedTarget = this.normalizeString(target, normalization);
        const escaped = this.escapeRegExp(normalizedTarget);
        
        if (normalization === "exact") {
            return new RegExp(escaped, 'g');
        } else if (normalization === "whitespace") {
            // Flexible whitespace regex logic
            // Replace \n with pattern that matches \r?\n and optional surrounding whitespace
            const parts = escaped.split('\\n');
            // Allow for varying indentation and line endings between lines
            return new RegExp(parts.join('\\s*\\r?\\n\\s*'), 'g');
        } else {
            // Structural fallback
            return new RegExp(escaped.replace(/\s+/g, '\\s+'), 'g');
        }
    }

    private createFuzzyRegex(target: string): RegExp {
        // Normalize target whitespace first
        const normalized = target.trim().replace(/\s+/g, ' ');
        const escaped = this.escapeRegExp(normalized);
        const words = escaped.split(/\s/).filter((word) => word.length > 0);
        
        if (words.length === 0) {
             // If target is only whitespace, match any whitespace sequence
            return /\s+/g;
        }

        // Allow flexible whitespace: \s* for optional, \s+ for required
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
        if (index >= content.length) return false;
        
        const prev = content[index - 1];
        const curr = content[index];
        
        // Word boundaries: whitespace or punctuation to alphanumeric
        const isWordBoundary = (
            /\s/.test(prev) && !/\s/.test(curr)
        ) || (
            /[^\w]/.test(prev) && /\w/.test(curr)
        );
        
        return isWordBoundary;
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
            throw new Error(
                `Levenshtein fuzzy matching works best with strings under 256 characters.\n` +
                `Your target is ${targetLen} characters.\n` +
                `Suggestions:\n` +
                `- Break into smaller edits\n` +
                `- Use fuzzyMode: "whitespace" instead\n` +
                `- Use indexRange for precise character-based replacement`
            );
        }

        const tolerance = targetLen < 10 
            ? Math.max(1, Math.floor(targetLen * 0.2))
            : Math.floor(targetLen * 0.3);

        const timeoutMs = 5000;
        const deadline = Date.now() + timeoutMs;
        const targetTrigrams = this.trigramKeys(target);
        const { start: searchStart, end: searchEnd } = lineRange
            ? this.getCharRangeForLineRange(lineRange, lineCounter, content.length)
            : { start: 0, end: content.length };

        const lines = content.split(/\r?\n/);
        const strongCandidates: Array<{ lineNumber: number; similarity: number }> = [];
        const allCandidates: Array<{ lineNumber: number; similarity: number }> = [];

        for (let i = 0; i < lines.length; i++) {
            const lineNumber = i + 1;
            if (lineRange && (lineNumber < lineRange.start || lineNumber > lineRange.end)) {
                continue;
            }
            const lineTrigrams = this.trigramKeys(lines[i]);
            const similarity = this.jaccardSimilarity(targetTrigrams, lineTrigrams);
            const entry = { lineNumber, similarity };
            allCandidates.push(entry);
            if (similarity >= 0.3) {
                strongCandidates.push(entry);
            }
        }

        if (allCandidates.length === 0) {
            const fallbackLine = Math.min(
                Math.max(1, lineRange?.start ?? 1),
                Math.max(1, lineCounter.lineCount)
            );
            allCandidates.push({ lineNumber: fallbackLine, similarity: 0 });
        }

        let candidates = strongCandidates.length > 0 ? strongCandidates : allCandidates;
        candidates = [...candidates]
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 50);

        const matches: { start: number; end: number; distance: number; original: string }[] = [];
        const MAX_OPS = 100000;
        let ops = 0;
        const minLen = Math.max(1, targetLen - tolerance);
        const maxWindow = targetLen + tolerance;

        for (const candidate of candidates) {
            const lineStart = lineCounter.getCharIndexForLine(candidate.lineNumber);
            const windowStart = Math.max(searchStart, Math.max(0, lineStart - maxWindow));
            const windowEnd = Math.min(searchEnd, Math.min(content.length, lineStart + maxWindow * 2));

            if (windowEnd <= windowStart) {
                continue;
            }

            for (let position = windowStart; position <= windowEnd - minLen; position++) {
                if (!this.isBoundaryPosition(content, position)) continue;

                const maxCandidateEnd = Math.min(windowEnd, position + maxWindow);
                const usableLength = maxCandidateEnd - position;
                const maxLen = Math.min(usableLength, targetLen + tolerance);

                for (let len = minLen; len <= maxLen; len++) {
                    if (Date.now() > deadline) {
                        throw new Error(
                            `Fuzzy match exceeded ${timeoutMs}ms timeout.\n` +
                            `Suggestions:\n` +
                            `- Narrow the search scope with lineRange\n` +
                            `- Use more specific targetString\n` +
                            `- Try fuzzyMode: "whitespace" instead`
                        );
                    }

                    ops++;
                    if (ops > MAX_OPS) {
                        throw new Error(
                            `Fuzzy search exceeded computational limit.\n` +
                            `Suggestions:\n` +
                            `- Add lineRange to narrow search scope\n` +
                            `- Use more specific targetString\n` +
                            `- Try fuzzyMode: "whitespace" instead`
                        );
                    }

                    const candidateStr = content.substring(position, position + len);
                    if (!candidateStr) {
                        continue;
                    }

                    const localTrigrams = this.trigramKeys(candidateStr);
                    const similarity = this.jaccardSimilarity(targetTrigrams, localTrigrams);
                    if (similarity < 0.2) {
                        continue;
                    }

                    const distance = levenshtein.get(target, candidateStr);
                    if (distance <= tolerance) {
                        matches.push({
                            start: position,
                            end: position + len,
                            distance,
                            original: candidateStr
                        });
                    }
                }
            }
        }

        matches.sort((a, b) => a.distance - b.distance || a.start - b.start);
        const uniqueMatches: Match[] = [];
        
        for (const cand of matches) {
            const isOverlapping = uniqueMatches.some(m => 
                (cand.start >= m.start && cand.start < m.end) || 
                (cand.end > m.start && cand.end <= m.end)
            );
            
            if (!isOverlapping) {
                const lineNumber = lineCounter.getLineNumber(cand.start);
                uniqueMatches.push({
                    start: cand.start,
                    end: cand.end,
                    replacement,
                    original: cand.original,
                    lineNumber,
                    matchType: 'levenshtein'
                });
            }
        }

        return uniqueMatches;
    }

    private scoreMatchConfidence(
        match: Match,
        edit: Edit,
        content: string
    ): number {
        let score = 0.5;  // Base score
        
        // Exact match = highest confidence
        if (match.original === edit.targetString) {
            score = 1.0;
        }
        // Levenshtein = lower confidence based on distance
        else if (edit.fuzzyMode === 'levenshtein') {
            const distance = levenshtein.get(edit.targetString, match.original);
            const maxDistance = Math.floor(edit.targetString.length * 0.3);
            score = 0.5 + (0.5 * (1 - distance / (maxDistance || 1)));
        }
        // Whitespace fuzzy = medium confidence
        else if (edit.fuzzyMode === 'whitespace') {
            score = 0.8;
        }
        
        // Boost score if context matches
        if (edit.beforeContext || edit.afterContext) {
            score = Math.min(1.0, score + 0.15);
        }
        
        // Boost score if lineRange constrains search
        if (edit.lineRange) {
            score = Math.min(1.0, score + 0.1);
        }
        
        return score;
    }

    private generateMatchFailureDiagnostics(
        content: string,
        edit: Edit,
        matches: Match[],
        filteredMatches: Match[],
        options?: { normalizationAttempts?: { level: NormalizationLevel; matchCount: number; }[] }
    ): string {
        const diagnostics: string[] = [];
        
        diagnostics.push(`Target not found: "${edit.targetString}"`);
        diagnostics.push(`\nDiagnostics:`);
        
        const mode = edit.fuzzyMode || 'exact';
        diagnostics.push(`- Matching mode: ${mode}`);
        
        if (options?.normalizationAttempts && options.normalizationAttempts.length > 0) {
            const attemptSummary = options.normalizationAttempts
                .map((attempt) => `${attempt.level}(${attempt.matchCount})`)
                .join(', ');
            diagnostics.push(`- Normalization attempts: ${attemptSummary}`);
        }

        if (matches.length === 0) {
            diagnostics.push(`- Initial search found 0 matches`);
            diagnostics.push(`- Tip: Try fuzzyMode: "whitespace" or "levenshtein"`);
            
            // Suggest similar strings using Levenshtein (simple line scan)
            const lines = content.split('\n');
            const targetWords = edit.targetString.toLowerCase().split(/\s+/);
            const potentialMatches: Array<{line: number, text: string, score: number}> = [];
            
            lines.forEach((line, idx) => {
                const lineWords = line.toLowerCase().split(/\s+/);
                const commonWords = targetWords.filter(w => lineWords.includes(w));
                if (commonWords.length > 0 && targetWords.length > 0) {
                    potentialMatches.push({
                        line: idx + 1,
                        text: line.trim().substring(0, 80),
                        score: commonWords.length / targetWords.length
                    });
                }
            });
            
            if (potentialMatches.length > 0) {
                potentialMatches.sort((a, b) => b.score - a.score);
                diagnostics.push(`\n- Potential similar lines found:`);
                potentialMatches.slice(0, 3).forEach(m => {
                    diagnostics.push(`  Line ${m.line}: "${m.text}"`);
                });
            }
        } else {
            diagnostics.push(`- Initial search found ${matches.length} match(es)`);
            diagnostics.push(`- After filtering: ${filteredMatches.length} match(es)`);
            
            if (edit.lineRange) {
                const lineFiltered = matches.filter(m => 
                    m.lineNumber < edit.lineRange!.start || m.lineNumber > edit.lineRange!.end
                );
                if (lineFiltered.length > 0) {
                    diagnostics.push(`- ${lineFiltered.length} match(es) outside lineRange [${edit.lineRange.start}, ${edit.lineRange.end}]:`);
                    lineFiltered.forEach(m => {
                        diagnostics.push(`  Line ${m.lineNumber}: "${m.original.substring(0, 50)}..."`);
                    });
                }
            }
            
            if (edit.beforeContext) {
                const contextFailed = matches.filter(m => {
                    const searchStart = edit.anchorSearchRange?.chars
                        ? Math.max(0, m.start - edit.anchorSearchRange.chars)
                        : 0;
                    const preceding = content.substring(searchStart, m.start);
                    if (edit.fuzzyMode === "whitespace") {
                        return !preceding.replace(/\s+/g, " ").includes(edit.beforeContext!.replace(/\s+/g, " "));
                    }
                    return !preceding.includes(edit.beforeContext!);
                });
                
                if (contextFailed.length > 0) {
                    diagnostics.push(`- ${contextFailed.length} match(es) failed beforeContext: "${edit.beforeContext}"`);
                }
            }
            
            if (edit.afterContext) {
                const contextFailed = matches.filter(m => {
                    const searchEnd = edit.anchorSearchRange?.chars
                        ? Math.min(content.length, m.end + edit.anchorSearchRange.chars)
                        : content.length;
                    const following = content.substring(m.end, searchEnd);
                    if (edit.fuzzyMode === "whitespace") {
                        return !following.replace(/\s+/g, " ").includes(edit.afterContext!.replace(/\s+/g, " "));
                    }
                    return !following.includes(edit.afterContext!);
                });
                
                if (contextFailed.length > 0) {
                    diagnostics.push(`- ${contextFailed.length} match(es) failed afterContext: "${edit.afterContext}"`);
                }
            }
        }
        
        diagnostics.push(`\nSuggestions:`);
        if (matches.length === 0) {
            diagnostics.push(`- Verify the target string exists in the file`);
            diagnostics.push(`- Check for typos or whitespace differences`);
            diagnostics.push(`- Try: fuzzyMode: "whitespace" for flexible whitespace`);
            diagnostics.push(`- Try: fuzzyMode: "levenshtein" for typo tolerance`);
        } else {
            diagnostics.push(`- Remove or adjust lineRange`);
            diagnostics.push(`- Adjust beforeContext/afterContext`);
        }
        
        return diagnostics.join('\n');
    }

    private generateAmbiguousMatchError(
        content: string,
        edit: Edit,
        matches: Match[]
    ): AmbiguousMatchError {
        const scoredMatches = matches.map(m => ({
            ...m,
            confidence: this.scoreMatchConfidence(m, edit, content)
        })).sort((a, b) => b.confidence! - a.confidence!);
        
        const lines = content.split('\n');
        
        const contextSnippets = scoredMatches.map(m => {
            const line = lines[m.lineNumber - 1];
            return `Line ${m.lineNumber} (confidence: ${(m.confidence! * 100).toFixed(0)}%): "${line.trim().substring(0, 80)}..."`;
        });
        
        const message = [
            `Ambiguous match for "${edit.targetString}". Found ${matches.length} occurrences:`,
            '',
            ...contextSnippets.slice(0, 5), // Show top 5
            matches.length > 5 ? `... and ${matches.length - 5} more.` : '',
            '',
            `Best match appears to be line ${scoredMatches[0].lineNumber}.`,
            `Resolution strategies:`,
            `1. Add lineRange: { start: ${scoredMatches[0].lineNumber}, end: ${scoredMatches[0].lineNumber} }`,
            `2. Add beforeContext/afterContext`
        ].join('\n');
        
        return new AmbiguousMatchError(message, { 
            conflictingLines: matches.map(m => m.lineNumber)
        });
    }

    private findMatch(content: string, edit: Edit, lineCounter: LineCounter): Match {
        let matches: Match[] = [];
        const normalizationDiagnostics: { level: NormalizationLevel; matchCount: number }[] = [];

        if (edit.fuzzyMode === "levenshtein") {
            // Try exact match first
            const exactRegex = this.createExactRegex(edit.targetString);
            const exactMatches = [...content.matchAll(exactRegex)].map(m => ({
                start: m.index!,
                end: m.index! + m[0].length,
                replacement: edit.replacementString,
                original: m[0],
                lineNumber: lineCounter.getLineNumber(m.index!),
                matchType: 'exact' as const
            }));

            if (exactMatches.length > 0) {
                matches = exactMatches;
            } else {
                matches = this.findLevenshteinCandidates(content, edit.targetString, edit.replacementString, lineCounter, edit.lineRange);
            }
        } else if (edit.fuzzyMode === "whitespace") {
            const regex = this.createFuzzyRegex(edit.targetString);
            matches = [...content.matchAll(regex)].map(m => ({
                start: m.index!,
                end: m.index! + m[0].length,
                replacement: edit.replacementString,
                original: m[0],
                lineNumber: lineCounter.getLineNumber(m.index!),
                matchType: 'whitespace-fuzzy' as const
            }));
        } else {
            const attempts = this.getNormalizationAttempts(edit.normalization);
            for (const level of attempts) {
                const regex = this.createExactRegex(edit.targetString, level);
                const matchType: Match['matchType'] = level === 'exact' ? 'exact' : 'normalization';
                const attemptMatches = [...content.matchAll(regex)].map(m => ({
                    start: m.index!,
                    end: m.index! + m[0].length,
                    replacement: edit.replacementString,
                    original: m[0],
                    lineNumber: lineCounter.getLineNumber(m.index!),
                    matchType
                }));
                normalizationDiagnostics.push({ level, matchCount: attemptMatches.length });
                if (attemptMatches.length > 0) {
                    matches = attemptMatches;
                    break;
                }
            }
        }

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
            throw new MatchNotFoundError(
                this.generateMatchFailureDiagnostics(content, edit, matches, filteredMatches, {
                    normalizationAttempts: normalizationDiagnostics
                })
            );
        }
        if (filteredMatches.length > 1) {
            throw this.generateAmbiguousMatchError(content, edit, filteredMatches);
        }

        return filteredMatches[0];
    }

    private getCharRangeForLineRange(lineRange: LineRange, lineCounter: LineCounter, contentLength: number): { start: number; end: number } {
        const startIndex = lineCounter.getCharIndexForLine(lineRange.start);
        const endIndex = lineRange.end >= lineCounter.lineCount
            ? contentLength
            : lineCounter.getCharIndexForLine(lineRange.end + 1);
        return { start: startIndex, end: endIndex };
    }

    private computeHash(value: string, algorithm: 'sha256' | 'xxhash'): string {
        if (algorithm === 'xxhash' && XXH) {
            return XXH.h64(0xABCD).update(value).digest().toString(16);
        }
        return crypto.createHash('sha256').update(value).digest('hex');
    }

    private buildSuggestion(code: string, filePath: string, edit?: Edit): ToolSuggestion | undefined {
        const relativePath = path.relative(this.rootPath, filePath);
        const buildArgs = (extras: Record<string, unknown>): Record<string, unknown> => {
            const args: Record<string, unknown> = { filePath: relativePath, ...extras };
            Object.keys(args).forEach(key => args[key] === undefined && delete args[key]);
            return args;
        };

        switch (code) {
            case "NO_MATCH":
                return {
                    toolName: "debug_edit_match",
                    rationale: "Check normalization and anchors before retrying the edit.",
                    exampleArgs: buildArgs({
                        targetString: edit?.targetString,
                        lineRange: edit?.lineRange,
                        normalization: edit?.normalization ?? "whitespace"
                    })
                };
            case "AMBIGUOUS_MATCH":
                return {
                    toolName: "debug_edit_match",
                    rationale: "Identify conflicting regions and tighten lineRange or context before retrying.",
                    exampleArgs: buildArgs({
                        targetString: edit?.targetString,
                        lineRange: edit?.lineRange
                    })
                };
            case "HASH_MISMATCH":
                return {
                    toolName: "read_file",
                    rationale: "Re-read the Smart File Profile to refresh hashes before editing again.",
                    exampleArgs: buildArgs({})
                };
            default:
                return undefined;
        }
    }

    private validateExpectedHash(
        edit: Edit,
        content: string,
        match: Match,
        lineCounter: LineCounter
    ): void {
        if (!edit.expectedHash) return;

        const { algorithm, value } = edit.expectedHash;
        const range = edit.lineRange
            ? this.getCharRangeForLineRange(edit.lineRange, lineCounter, content.length)
            : { start: match.start, end: match.end };

        const slice = content.substring(range.start, range.end);
        const computed = this.computeHash(slice, algorithm);

        if (computed !== value) {
            const err = new HashMismatchError(
                `Hash mismatch detected for ${edit.lineRange ? `lines ${edit.lineRange.start}-${edit.lineRange.end}` : `target "${edit.targetString}"`}. ` +
                `Expected ${value}, computed ${computed}.`
            );
            (err as any).edit = edit;
            throw err;
        }
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

                if (edit.expectedHash) {
                    const computed = this.computeHash(existing, edit.expectedHash.algorithm);
                    if (computed !== edit.expectedHash.value) {
                        const err = new HashMismatchError(
                            `Hash mismatch detected for index range [${start}, ${end}). Expected ${edit.expectedHash.value}, computed ${computed}.`
                        );
                        (err as any).edit = edit;
                        throw err;
                    }
                }

                plannedMatches.push({
                    start,
                    end,
                    replacement: edit.replacementString,
                    original: existing,
                    lineNumber: lineCounter.getLineNumber(start),
                    matchType: 'exact'
                });
            } else {
                try {
                    const match = this.findMatch(originalContent, edit, lineCounter);
                    this.validateExpectedHash(edit, originalContent, match, lineCounter);
                    plannedMatches.push(match);
                } catch (error) {
                    (error as any).edit = edit;
                    throw error;
                }
            }
        }

        plannedMatches.sort((a, b) => a.start - b.start);

        for (let i = 0; i < plannedMatches.length - 1; i++) {
            if (plannedMatches[i].end > plannedMatches[i + 1].start) {
                throw new Error(
                    `Conflict detected: Edit for "${plannedMatches[i].original}" overlaps with "${plannedMatches[i + 1].original}".`
                );
            }
        }

        return plannedMatches;
    }

    public getDiagnostics(content: string, edit: Edit): MatchDiagnostics {
        const lineCounter = new LineCounter(content);
        const diagnostics: MatchDiagnostics = { attempts: [] };

        // Attempt 1: Exact
        diagnostics.attempts.push({
            mode: "exact",
            candidates: [],
            failureReason: "Exact match failed"
        });

        // Attempt 2: Whitespace
        const wsRegex = this.createExactRegex(edit.targetString, "whitespace");
        const wsCandidates: { line: number; snippet: string }[] = [];
        let match;
        while ((match = wsRegex.exec(content)) !== null) {
            wsCandidates.push({
                line: lineCounter.lineAt(match.index),
                snippet: match[0].substring(0, 50) + "..."
            });
        }
        diagnostics.attempts.push({
            mode: "whitespace",
            candidates: wsCandidates,
            failureReason: wsCandidates.length === 0 ? "No whitespace-tolerant matches found" : "Matches found but not selected (ambiguous?)"
        });

        const structuralRegex = this.createExactRegex(edit.targetString, "structural");
        const structuralCandidates: { line: number; snippet: string }[] = [];
        let structuralMatch;
        while ((structuralMatch = structuralRegex.exec(content)) !== null) {
            structuralCandidates.push({
                line: lineCounter.lineAt(structuralMatch.index),
                snippet: structuralMatch[0].substring(0, 50) + "..."
            });
        }
        diagnostics.attempts.push({
            mode: "structural",
            candidates: structuralCandidates,
            failureReason: structuralCandidates.length === 0 ? "No structural matches found" : "Matches found but likely need tighter anchors"
        });

        return diagnostics;
    }

    public async applyEdits(
        filePath: string,
        edits: Edit[],
        dryRun: boolean = false,
        options?: ApplyEditsOptions
    ): Promise<EditResult> {
        if (!(await this.fileSystem.exists(filePath))) {
            return { success: false, message: `File not found: ${filePath}` };
        }
        const diffMode: DiffMode = options?.diffMode === "semantic" ? "semantic" : "myers";

        const originalContent = await this.fileSystem.readFile(filePath);
        let plannedMatches: Match[];

        try {
            plannedMatches = this.applyEditsInternal(originalContent, edits);
        } catch (error: any) {
            const failingEdit = (error as any).edit as Edit | undefined;
            if (error instanceof AmbiguousMatchError) {
                return {
                    success: false,
                    message: error.message,
                    details: { conflictingLines: error.conflictingLines },
                    suggestion: this.buildSuggestion("AMBIGUOUS_MATCH", filePath, failingEdit),
                    errorCode: "AMBIGUOUS_MATCH",
                };
            }
            if (error instanceof MatchNotFoundError) {
                return {
                    success: false,
                    message: error.message,
                    errorCode: "NO_MATCH",
                    suggestion: this.buildSuggestion("NO_MATCH", filePath, failingEdit)
                };
            }
            if (error instanceof HashMismatchError) {
                return {
                    success: false,
                    message: error.message,
                    errorCode: "HASH_MISMATCH",
                    suggestion: this.buildSuggestion("HASH_MISMATCH", filePath, failingEdit)
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
            let diffText: string;
            let added = 0;
            let removed = 0;
            let semanticSummary: SemanticDiffSummary | undefined;

            if (diffMode === "semantic") {
                const hunks = PatienceDiff.diff(originalContent, newContent, {
                    contextLines: 3,
                    semantic: true
                });
                const summary = PatienceDiff.summarize(hunks);
                diffText = PatienceDiff.formatUnified(hunks);
                added = summary.added;
                removed = summary.removed;
                if (this.semanticDiffProvider) {
                    semanticSummary = await this.semanticDiffProvider.diff(filePath, originalContent, newContent);
                }
            } else {
                const summary = MyersDiff.diffLinesStructured(originalContent, newContent);
                diffText = summary.diff;
                added = summary.added;
                removed = summary.removed;
            }
            const relativePath = path.relative(this.rootPath, filePath);
            return {
                success: true,
                originalContent,
                newContent,
                diff: diffText,
                structuredDiff: [{
                    filePath: relativePath,
                    diff: diffText,
                    added,
                    removed
                }],
                semanticSummary,
                diffModeUsed: diffMode,
                operation
            };
        }

        const relativePath = path.relative(this.rootPath, filePath);
        await this._createTimestampedBackup(relativePath, originalContent);
        await this._enforceRetentionPolicy(relativePath);
        await this.fileSystem.writeFile(filePath, newContent);

        return {
            success: true,
            message: `Successfully applied ${edits.length} edits.`,
            diffModeUsed: diffMode,
            operation: {
                ...operation,
                filePath: relativePath,
            },
        };
    }
}
