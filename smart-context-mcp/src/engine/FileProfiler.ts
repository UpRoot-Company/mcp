import * as path from 'path';
import * as fs from 'fs';

export interface FileMetadataAnalysis {
    newlineStyle: "lf" | "crlf" | "mixed";
    hasBOM: boolean;
    usesTabs: boolean;
    indentSize: number | null;
    isConfigFile: boolean;
    configType?: 'tsconfig' | 'package.json' | 'lintrc' | 'editorconfig' | 'other';
    configScope?: 'project' | 'directory' | 'file';
}

export class FileProfiler {
    public static analyzeMetadata(content: string, filePath: string): FileMetadataAnalysis {
        return {
            ...this.analyzeFormatting(content),
            ...this.analyzeConfigType(filePath)
        };
    }

    private static analyzeFormatting(content: string): Pick<FileMetadataAnalysis, 'newlineStyle' | 'hasBOM' | 'usesTabs' | 'indentSize'> {
        // BOM Detection
        const hasBOM = content.charCodeAt(0) === 0xFEFF;
        
        // Newline Style Detection
        let newlineStyle: "lf" | "crlf" | "mixed" = "lf";
        const hasCRLF = /\r\n/.test(content);
        const hasLF = /[^\r]\n/.test(content);
        
        if (hasCRLF && hasLF) {
            newlineStyle = "mixed";
        } else if (hasCRLF) {
            newlineStyle = "crlf";
        } else {
            newlineStyle = "lf";
        }

        // Indentation Detection (simple heuristic)
        let usesTabs = false;
        let indentSize: number | null = null;
        
        const lines = content.split(/\r?\n/);
        const indentations: number[] = [];
        let tabCount = 0;
        let spaceCount = 0;

        for (const line of lines) {
            if (line.trim().length === 0) continue;
            
            const match = line.match(/^(\s+)/);
            if (match) {
                const whitespace = match[1];
                if (whitespace.includes('\t')) {
                    tabCount++;
                    usesTabs = true;
                } else {
                    spaceCount++;
                    indentations.push(whitespace.length);
                }
            }
        }

        if (spaceCount > tabCount) {
            usesTabs = false;
            if (indentations.length > 0) {
                // Find most common GCD of indentations
                indentSize = this.detectIndentSize(indentations);
            }
        } else if (tabCount > 0) {
            usesTabs = true;
            indentSize = 4; // default visual size, usually
        }

        return {
            newlineStyle,
            hasBOM,
            usesTabs,
            indentSize
        };
    }

    private static detectIndentSize(indentations: number[]): number | null {
        // Count frequencies of indent lengths
        const counts = new Map<number, number>();
        for (const indent of indentations) {
            counts.set(indent, (counts.get(indent) || 0) + 1);
        }

        // Sort by frequency
        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) return null;

        // Return the most frequent indentation width
        return sorted[0][0];
    }

    private static analyzeConfigType(filePath: string): Pick<FileMetadataAnalysis, 'isConfigFile' | 'configType' | 'configScope'> {
        const filename = path.basename(filePath).toLowerCase();
        
        let isConfigFile = false;
        let configType: FileMetadataAnalysis['configType'];
        let configScope: FileMetadataAnalysis['configScope'];

        if (filename === 'tsconfig.json' || filename === 'jsconfig.json') {
            isConfigFile = true;
            configType = 'tsconfig';
            configScope = 'project';
        } else if (filename === 'package.json') {
            isConfigFile = true;
            configType = 'package.json';
            configScope = 'project';
        } else if (filename.includes('.eslintrc') || filename === 'eslint.config.js') {
            isConfigFile = true;
            configType = 'lintrc';
            configScope = 'project'; // simplified
        } else if (filename === '.editorconfig') {
            isConfigFile = true;
            configType = 'editorconfig';
            configScope = 'project';
        } else if (filename.endsWith('.json') || filename.endsWith('.yaml') || filename.endsWith('.yml') || filename.endsWith('.toml') || filename.startsWith('.')) {
             // Broad catch for other configs
             if (!configType) {
                 isConfigFile = true;
                 configType = 'other';
                 configScope = 'directory'; // assumption
             }
        }

        return {
            isConfigFile,
            configType,
            configScope
        };
    }
}
