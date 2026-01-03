/**
 * ADR-042-006: Phase 2.5 - StyleInference
 * 
 * Infers coding style from existing project files.
 * Supports EditorConfig parsing and majority voting from file samples.
 */

import { IFileSystem } from '../platform/FileSystem.js';
import * as path from 'path';

/**
 * Inferred code style configuration
 */
export interface CodeStyle {
    /** Indentation style: 'spaces' or 'tabs' */
    indent: 'spaces' | 'tabs';
    /** Number of spaces per indent level (only for spaces) */
    indentSize: number;
    /** Quote style: 'single' or 'double' */
    quotes: 'single' | 'double';
    /** Whether to use semicolons */
    semicolons: boolean;
    /** Line ending style: 'lf' or 'crlf' */
    lineEndings: 'lf' | 'crlf';
    /** Trailing comma in multi-line structures */
    trailingComma?: boolean;
}

/**
 * Configuration for style inference
 */
export interface StyleInferenceConfig {
    /** Maximum number of files to sample */
    maxSampleFiles: number;
    /** File extensions to analyze */
    fileExtensions: string[];
    /** Minimum confidence threshold (0-1) */
    minConfidence: number;
}

const DEFAULT_CONFIG: StyleInferenceConfig = {
    maxSampleFiles: 20,
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    minConfidence: 0.6,
};

/**
 * Statistics for a style feature
 */
interface StyleStats {
    count: number;
    total: number;
    confidence: number;
}

/**
 * StyleInference - Phase 2.5 Quick Win
 * 
 * Analyzes existing project files to infer consistent coding style.
 * Supports:
 * - EditorConfig parsing (.editorconfig)
 * - Majority voting from file samples
 * - Confidence scoring
 */
export class StyleInference {
    private readonly config: StyleInferenceConfig;

    constructor(
        private readonly fileSystem: IFileSystem,
        private readonly rootPath: string,
        config?: Partial<StyleInferenceConfig>
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Infer code style from project files
     * 
     * @param targetExtension Target file extension (defaults to .ts)
     * @returns Inferred CodeStyle with confidence scores
     */
    public async inferStyle(targetExtension: string = '.ts'): Promise<CodeStyle & { confidence: number }> {
        // 1. Try EditorConfig first
        const editorConfigStyle = await this.parseEditorConfig(targetExtension);
        if (editorConfigStyle) {
            return { ...editorConfigStyle, confidence: 1.0 };
        }

        // 2. Fallback to majority voting from file samples
        const sampleFiles = await this.collectSampleFiles(targetExtension);
        if (sampleFiles.length === 0) {
            return this.getDefaultStyle();
        }

        const styles = await this.analyzeSamples(sampleFiles);
        return this.computeMajorityStyle(styles);
    }

    /**
     * Parse .editorconfig file if exists
     */
    private async parseEditorConfig(extension: string): Promise<CodeStyle | null> {
        const editorConfigPath = path.join(this.rootPath, '.editorconfig');
        
        try {
            if (!await this.fileSystem.exists(editorConfigPath)) {
                return null;
            }

            const content = await this.fileSystem.readFile(editorConfigPath);
            const lines = content.split('\n');

            let inTargetSection = false;
            let inGlobalSection = false;
            const config: Partial<CodeStyle> = {};

            for (const line of lines) {
                const trimmed = line.trim();
                
                // Skip comments and empty lines
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
                    continue;
                }

                // Check for section headers
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                    const section = trimmed.slice(1, -1);
                    inGlobalSection = section === '*';
                    inTargetSection = this.matchesExtension(section, extension);
                    continue;
                }

                // Parse key-value pairs
                if (inTargetSection || inGlobalSection) {
                    const [key, value] = trimmed.split('=').map(s => s.trim());
                    
                    if (key === 'indent_style') {
                        config.indent = value === 'tab' ? 'tabs' : 'spaces';
                    } else if (key === 'indent_size' || key === 'tab_width') {
                        config.indentSize = parseInt(value, 10);
                    } else if (key === 'end_of_line') {
                        config.lineEndings = value === 'crlf' ? 'crlf' : 'lf';
                    }
                }
            }

            // Return if we got meaningful config
            if (config.indent || config.indentSize || config.lineEndings) {
                return {
                    indent: config.indent || 'spaces',
                    indentSize: config.indentSize || 2,
                    quotes: 'single', // EditorConfig doesn't specify quotes
                    semicolons: true,  // EditorConfig doesn't specify semicolons
                    lineEndings: config.lineEndings || 'lf',
                };
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Check if EditorConfig section matches file extension
     */
    private matchesExtension(section: string, extension: string): boolean {
        // Simple glob matching for common patterns
        if (section === '*') return true;
        if (section === `*${extension}`) return true;
        if (section.includes(extension)) return true;
        
        // Handle patterns like *.{ts,tsx}
        const match = section.match(/\*\.{([^}]+)}/);
        if (match) {
            const extensions = match[1].split(',').map(e => e.trim());
            return extensions.includes(extension.slice(1));
        }

        return false;
    }

    /**
     * Collect sample files for analysis
     */
    private async collectSampleFiles(extension: string): Promise<string[]> {
        const files: string[] = [];
        
        try {
            await this.walkDirectory(this.rootPath, extension, files, this.config.maxSampleFiles);
        } catch (error) {
            // If walk fails, return empty array
        }

        return files;
    }

    /**
     * Recursively walk directory to collect files
     */
    private async walkDirectory(
        dir: string,
        extension: string,
        files: string[],
        maxFiles: number
    ): Promise<void> {
        if (files.length >= maxFiles) return;

        try {
            const entries = await this.fileSystem.readDir(dir);
            
            for (const entryName of entries) {
                if (files.length >= maxFiles) break;

                const fullPath = path.join(dir, entryName);

                // Check if it's a directory
                try {
                    const stats = await this.fileSystem.stat(fullPath);
                    
                    if (stats.isDirectory()) {
                        if (this.shouldSkipDirectory(entryName)) {
                            continue;
                        }
                        await this.walkDirectory(fullPath, extension, files, maxFiles);
                    } else {
                        if (fullPath.endsWith(extension)) {
                            files.push(fullPath);
                        }
                    }
                } catch {
                    // Skip entries we can't stat
                }
            }
        } catch (error) {
            // Skip directories we can't read
        }
    }

    /**
     * Check if directory should be skipped
     */
    private shouldSkipDirectory(name: string): boolean {
        const skipDirs = ['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv'];
        return skipDirs.includes(name);
    }

    /**
     * Analyze sample files to extract style statistics
     */
    private async analyzeSamples(files: string[]): Promise<CodeStyle[]> {
        const styles: CodeStyle[] = [];

        for (const file of files) {
            try {
                const content = await this.fileSystem.readFile(file);
                const style = this.analyzeFileContent(content);
                styles.push(style);
            } catch (error) {
                // Skip files we can't read
            }
        }

        return styles;
    }

    /**
     * Analyze single file content to extract style
     */
    private analyzeFileContent(content: string): CodeStyle {
        const lines = content.split('\n');

        // Detect indentation
        let spaceIndents = 0;
        let tabIndents = 0;
        const indentSizes = new Map<number, number>();

        for (const line of lines) {
            if (line.length === 0 || line.trim().length === 0) continue;

            const leadingWhitespace = line.match(/^(\s+)/);
            if (!leadingWhitespace) continue;

            const whitespace = leadingWhitespace[1];
            if (whitespace.includes('\t')) {
                tabIndents++;
            } else {
                spaceIndents++;
                const size = whitespace.length;
                if (size > 0 && size <= 8) {
                    indentSizes.set(size, (indentSizes.get(size) || 0) + 1);
                }
            }
        }

        const indent: 'spaces' | 'tabs' = tabIndents > spaceIndents ? 'tabs' : 'spaces';
        const indentSize = this.getMostCommonIndentSize(indentSizes) || 2;

        // Detect quotes
        const singleQuotes = (content.match(/'/g) || []).length;
        const doubleQuotes = (content.match(/"/g) || []).length;
        const quotes: 'single' | 'double' = singleQuotes > doubleQuotes ? 'single' : 'double';

        // Detect semicolons
        const linesWithSemicolon = lines.filter(l => l.trim().endsWith(';')).length;
        const codeLines = lines.filter(l => l.trim().length > 0 && !l.trim().startsWith('//')).length;
        const semicolons = linesWithSemicolon > codeLines * 0.5;

        // Detect line endings
        const lineEndings: 'lf' | 'crlf' = content.includes('\r\n') ? 'crlf' : 'lf';

        // Detect trailing comma
        const trailingCommaMatches = content.match(/,\s*[\n\r]+\s*[}\]]/g);
        const trailingComma = (trailingCommaMatches?.length || 0) > 3;

        return {
            indent,
            indentSize,
            quotes,
            semicolons,
            lineEndings,
            trailingComma,
        };
    }

    /**
     * Get most common indent size from statistics
     */
    private getMostCommonIndentSize(sizes: Map<number, number>): number {
        let maxCount = 0;
        let mostCommon = 2;

        for (const [size, count] of sizes.entries()) {
            if (count > maxCount) {
                maxCount = count;
                mostCommon = size;
            }
        }

        return mostCommon;
    }

    /**
     * Compute majority style from samples using voting
     */
    private computeMajorityStyle(styles: CodeStyle[]): CodeStyle & { confidence: number } {
        if (styles.length === 0) {
            return this.getDefaultStyle();
        }

        const indentVotes = { spaces: 0, tabs: 0 };
        const quotesVotes = { single: 0, double: 0 };
        const semicolonVotes = { yes: 0, no: 0 };
        const lineEndingVotes = { lf: 0, crlf: 0 };
        const indentSizes: number[] = [];
        const trailingCommaVotes = { yes: 0, no: 0 };

        for (const style of styles) {
            indentVotes[style.indent]++;
            quotesVotes[style.quotes]++;
            semicolonVotes[style.semicolons ? 'yes' : 'no']++;
            lineEndingVotes[style.lineEndings]++;
            indentSizes.push(style.indentSize);
            if (style.trailingComma !== undefined) {
                trailingCommaVotes[style.trailingComma ? 'yes' : 'no']++;
            }
        }

        const total = styles.length;
        const indent = indentVotes.spaces >= indentVotes.tabs ? 'spaces' : 'tabs';
        const quotes = quotesVotes.single >= quotesVotes.double ? 'single' : 'double';
        const semicolons = semicolonVotes.yes >= semicolonVotes.no;
        const lineEndings = lineEndingVotes.lf >= lineEndingVotes.crlf ? 'lf' : 'crlf';
        const trailingComma = trailingCommaVotes.yes >= trailingCommaVotes.no;

        // Calculate median indent size
        indentSizes.sort((a, b) => a - b);
        const indentSize = indentSizes[Math.floor(indentSizes.length / 2)] || 2;

        // Calculate overall confidence (average of individual confidences)
        const indentConfidence = Math.max(indentVotes.spaces, indentVotes.tabs) / total;
        const quotesConfidence = Math.max(quotesVotes.single, quotesVotes.double) / total;
        const semicolonConfidence = Math.max(semicolonVotes.yes, semicolonVotes.no) / total;
        const lineEndingConfidence = Math.max(lineEndingVotes.lf, lineEndingVotes.crlf) / total;

        const confidence = (indentConfidence + quotesConfidence + semicolonConfidence + lineEndingConfidence) / 4;

        return {
            indent,
            indentSize,
            quotes,
            semicolons,
            lineEndings,
            trailingComma,
            confidence,
        };
    }

    /**
     * Get default style (TypeScript defaults)
     */
    private getDefaultStyle(): CodeStyle & { confidence: number } {
        return {
            indent: 'spaces',
            indentSize: 2,
            quotes: 'single',
            semicolons: true,
            lineEndings: 'lf',
            trailingComma: true,
            confidence: 0.5, // Low confidence for defaults
        };
    }

    /**
     * Get current configuration
     */
    public getConfig(): StyleInferenceConfig {
        return { ...this.config };
    }
}
