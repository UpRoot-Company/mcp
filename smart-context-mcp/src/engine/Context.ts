import * as path from "path";
import { LineRange, ReadFragmentResult } from "../types.js";
import { IFileSystem } from "../platform/FileSystem.js";

export class ContextEngine {
    private ig: any;
    private readonly fileSystem: IFileSystem;

    constructor(ig: any, fileSystem: IFileSystem) {
        this.ig = ig;
        this.fileSystem = fileSystem;
    }

    private mergeIntervals(ranges: LineRange[]): LineRange[] {
        if (ranges.length === 0) return [];
        const sortedRanges = [...ranges].sort((a, b) => a.start - b.start);
        const merged: LineRange[] = [];
        let currentRange = sortedRanges[0];

        for (let i = 1; i < sortedRanges.length; i++) {
            const nextRange = sortedRanges[i];
            if (currentRange.end + 1 >= nextRange.start) {
                currentRange.end = Math.max(currentRange.end, nextRange.end);
            } else {
                merged.push(currentRange);
                currentRange = nextRange;
            }
        }
        merged.push(currentRange);
        return merged;
    }

    public async readFragment(filePath: string, ranges: LineRange[], contextLines: number = 0): Promise<ReadFragmentResult> {
        if (!(await this.fileSystem.exists(filePath))) {
            throw new Error(`File not found: ${filePath}`);
        }

        const fileContent = await this.fileSystem.readFile(filePath);
        const allLines = fileContent.split('\n');
        const totalLines = allLines.length;

        if (ranges.length === 0) {
            return {
                filePath,
                content: fileContent,
                ranges: [{ start: 1, end: totalLines }]
            };
        }

        const expandedRanges = ranges.map(r => ({
            start: Math.max(1, r.start - contextLines),
            end: Math.min(totalLines, r.end + contextLines)
        }));

        const mergedRanges = this.mergeIntervals(expandedRanges);
        let extractedContent = '';

        for (const range of mergedRanges) {
            const safeStart = Math.max(1, range.start);
            const safeEnd = Math.min(totalLines, range.end);
            extractedContent += `--- Lines ${safeStart}-${safeEnd} ---
`;
            const lines = allLines.slice(safeStart - 1, safeEnd);
            extractedContent += lines.join('\n') + '\n';
        }

        return {
            filePath,
            content: extractedContent,
            ranges: mergedRanges
        };
    }

    public async listDirectoryTree(dirPath: string, depth: number = 2, rootDir?: string): Promise<string> {
        if (!(await this.fileSystem.exists(dirPath))) {
            throw new Error(`Directory not found: ${dirPath}`);
        }
        const effectiveRootDir = rootDir || dirPath;
        return this.generateTree(effectiveRootDir, dirPath, '', depth);
    }

    private async generateTree(rootDir: string, currentPath: string, prefix: string, depthRemaining: number): Promise<string> {
        if (depthRemaining < 0) return '';

        let output = '';
        try {
            const items = await this.fileSystem.readDir(currentPath);
            const filteredItems = items.filter(item => {
                const relativePath = path.relative(rootDir, path.join(currentPath, item));
                return !this.ig.ignores(relativePath);
            });

            for (let i = 0; i < filteredItems.length; i++) {
                const item = filteredItems[i];
                const isLast = i === filteredItems.length - 1;
                const itemPath = path.join(currentPath, item);
                const stats = await this.fileSystem.stat(itemPath);

                const marker = isLast ? '└── ' : '├── ';
                const childPrefix = isLast ? '    ' : '│   ';

                if (stats.isDirectory()) {
                    output += `${prefix}${marker}${item}/
`;
                    if (depthRemaining > 0) {
                        output += await this.generateTree(rootDir, itemPath, prefix + childPrefix, depthRemaining - 1);
                    }
                } else {
                    output += `${prefix}${marker}${item}
`;
                }
            }
        } catch (error) {
            output += `${prefix}[Error reading directory]
`;
        }
        return output;
    }
}
