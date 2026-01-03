/**
 * ADR-042-006: Phase 3 - PatternExtractor
 * 
 * Extracts common patterns from project files:
 * - Import/export patterns
 * - Naming conventions (camelCase, PascalCase, kebab-case, etc.)
 * - File organization patterns
 * - Common code structures
 */

import { IFileSystem } from '../platform/FileSystem.js';
import * as path from 'path';

/**
 * Import pattern information
 */
export interface ImportPattern {
    /** Module being imported */
    module: string;
    /** Import style: default, named, namespace, side-effect */
    style: 'default' | 'named' | 'namespace' | 'side-effect';
    /** Named imports if style is 'named' */
    namedImports?: string[];
    /** Alias if used */
    alias?: string;
    /** Frequency count */
    count: number;
}

/**
 * Export pattern information
 */
export interface ExportPattern {
    /** Export style: default, named, namespace */
    style: 'default' | 'named' | 'namespace';
    /** What is being exported */
    exportedNames: string[];
    /** Frequency count */
    count: number;
}

/**
 * Naming convention pattern
 */
export interface NamingPattern {
    /** Pattern type */
    type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant';
    /** Convention: camelCase, PascalCase, UPPER_CASE, kebab-case */
    convention: 'camelCase' | 'PascalCase' | 'UPPER_CASE' | 'kebab-case' | 'snake_case';
    /** Confidence (0-1) */
    confidence: number;
    /** Sample names */
    samples: string[];
}

/**
 * File organization pattern
 */
export interface FilePattern {
    /** Common file name patterns */
    fileNamePattern: string;
    /** Common directory structures */
    directoryPattern: string;
    /** Test file patterns */
    testPattern?: string;
}

/**
 * Extracted project patterns
 */
export interface ProjectPatterns {
    /** Import patterns */
    imports: ImportPattern[];
    /** Export patterns */
    exports: ExportPattern[];
    /** Naming conventions */
    naming: NamingPattern[];
    /** File organization */
    fileOrg: FilePattern;
    /** Common prefixes/suffixes */
    affixes: {
        prefixes: string[];
        suffixes: string[];
    };
}

/**
 * Configuration for pattern extraction
 */
export interface PatternExtractionConfig {
    /** Maximum files to analyze */
    maxFiles: number;
    /** File extensions to include */
    extensions: string[];
    /** Minimum pattern frequency to include */
    minFrequency: number;
}

const DEFAULT_CONFIG: PatternExtractionConfig = {
    maxFiles: 50,
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    minFrequency: 2,
};

/**
 * PatternExtractor - Phase 3 Full Code Generation
 * 
 * Analyzes project files to extract common patterns:
 * - Import/export conventions
 * - Naming conventions
 * - File organization patterns
 * 
 * Used by TemplateGenerator to create code that matches project style.
 */
export class PatternExtractor {
    private readonly config: PatternExtractionConfig;

    constructor(
        private readonly fileSystem: IFileSystem,
        private readonly rootPath: string,
        config?: Partial<PatternExtractionConfig>
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Extract patterns from similar files
     * 
     * @param similarFiles Paths to files similar to target
     * @returns Extracted project patterns
     */
    public async extractPatterns(similarFiles: string[]): Promise<ProjectPatterns> {
        const filesToAnalyze = similarFiles.slice(0, this.config.maxFiles);
        
        const imports: Map<string, ImportPattern> = new Map();
        const exports: Map<string, ExportPattern> = new Map();
        const functionNames: string[] = [];
        const classNames: string[] = [];
        const interfaceNames: string[] = [];
        const variableNames: string[] = [];
        const constantNames: string[] = [];

        for (const filePath of filesToAnalyze) {
            try {
                const content = await this.fileSystem.readFile(filePath);
                
                // Extract imports
                this.extractImportPatterns(content, imports);
                
                // Extract exports
                this.extractExportPatterns(content, exports);
                
                // Extract naming patterns
                this.extractNamingPatterns(content, {
                    functionNames,
                    classNames,
                    interfaceNames,
                    variableNames,
                    constantNames,
                });
            } catch (error) {
                // Skip files we can't read
            }
        }

        return {
            imports: this.filterByFrequency(Array.from(imports.values())),
            exports: this.filterByFrequency(Array.from(exports.values())),
            naming: this.detectNamingConventions({
                functionNames,
                classNames,
                interfaceNames,
                variableNames,
                constantNames,
            }),
            fileOrg: this.extractFilePatterns(filesToAnalyze),
            affixes: this.extractAffixes({ functionNames, classNames, interfaceNames }),
        };
    }

    /**
     * Extract import patterns from file content
     */
    private extractImportPatterns(content: string, imports: Map<string, ImportPattern>): void {
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // import { x, y } from 'module'
            const namedMatch = trimmed.match(/^import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/);
            if (namedMatch) {
                const namedImports = namedMatch[1].split(',').map(s => s.trim());
                const module = namedMatch[2];
                const key = `named:${module}`;
                
                if (imports.has(key)) {
                    imports.get(key)!.count++;
                } else {
                    imports.set(key, {
                        module,
                        style: 'named',
                        namedImports,
                        count: 1,
                    });
                }
                continue;
            }

            // import x from 'module'
            const defaultMatch = trimmed.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
            if (defaultMatch) {
                const alias = defaultMatch[1];
                const module = defaultMatch[2];
                const key = `default:${module}`;
                
                if (imports.has(key)) {
                    imports.get(key)!.count++;
                } else {
                    imports.set(key, {
                        module,
                        style: 'default',
                        alias,
                        count: 1,
                    });
                }
                continue;
            }

            // import * as x from 'module'
            const namespaceMatch = trimmed.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
            if (namespaceMatch) {
                const alias = namespaceMatch[1];
                const module = namespaceMatch[2];
                const key = `namespace:${module}`;
                
                if (imports.has(key)) {
                    imports.get(key)!.count++;
                } else {
                    imports.set(key, {
                        module,
                        style: 'namespace',
                        alias,
                        count: 1,
                    });
                }
                continue;
            }

            // import 'module'
            const sideEffectMatch = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
            if (sideEffectMatch) {
                const module = sideEffectMatch[1];
                const key = `side-effect:${module}`;
                
                if (imports.has(key)) {
                    imports.get(key)!.count++;
                } else {
                    imports.set(key, {
                        module,
                        style: 'side-effect',
                        count: 1,
                    });
                }
            }
        }
    }

    /**
     * Extract export patterns from file content
     */
    private extractExportPatterns(content: string, exports: Map<string, ExportPattern>): void {
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // export { x, y }
            const namedMatch = trimmed.match(/^export\s+{([^}]+)}/);
            if (namedMatch) {
                const exportedNames = namedMatch[1].split(',').map(s => s.trim());
                const key = 'named';
                
                if (exports.has(key)) {
                    exports.get(key)!.count++;
                } else {
                    exports.set(key, {
                        style: 'named',
                        exportedNames,
                        count: 1,
                    });
                }
                continue;
            }

            // export default X
            if (trimmed.startsWith('export default ')) {
                const key = 'default';
                
                if (exports.has(key)) {
                    exports.get(key)!.count++;
                } else {
                    exports.set(key, {
                        style: 'default',
                        exportedNames: ['default'],
                        count: 1,
                    });
                }
                continue;
            }

            // export * from 'module'
            if (trimmed.match(/^export\s+\*\s+from/)) {
                const key = 'namespace';
                
                if (exports.has(key)) {
                    exports.get(key)!.count++;
                } else {
                    exports.set(key, {
                        style: 'namespace',
                        exportedNames: ['*'],
                        count: 1,
                    });
                }
            }
        }
    }

    /**
     * Extract naming patterns from file content
     */
    private extractNamingPatterns(
        content: string,
        collections: {
            functionNames: string[];
            classNames: string[];
            interfaceNames: string[];
            variableNames: string[];
            constantNames: string[];
        }
    ): void {
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // function functionName
            const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
            if (funcMatch) {
                collections.functionNames.push(funcMatch[1]);
            }

            // class ClassName
            const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
            if (classMatch) {
                collections.classNames.push(classMatch[1]);
            }

            // interface InterfaceName
            const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
            if (interfaceMatch) {
                collections.interfaceNames.push(interfaceMatch[1]);
            }

            // const CONSTANT_NAME = 
            const constMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=/);
            if (constMatch) {
                const name = constMatch[1];
                if (name === name.toUpperCase()) {
                    collections.constantNames.push(name);
                } else {
                    collections.variableNames.push(name);
                }
            }

            // let variableName = 
            const letMatch = trimmed.match(/^(?:export\s+)?let\s+(\w+)\s*=/);
            if (letMatch) {
                collections.variableNames.push(letMatch[1]);
            }
        }
    }

    /**
     * Detect naming conventions from collected names
     */
    private detectNamingConventions(collections: {
        functionNames: string[];
        classNames: string[];
        interfaceNames: string[];
        variableNames: string[];
        constantNames: string[];
    }): NamingPattern[] {
        const patterns: NamingPattern[] = [];

        // Function names
        if (collections.functionNames.length > 0) {
            const convention = this.detectConvention(collections.functionNames);
            patterns.push({
                type: 'function',
                convention,
                confidence: this.calculateConfidence(collections.functionNames, convention),
                samples: collections.functionNames.slice(0, 5),
            });
        }

        // Class names
        if (collections.classNames.length > 0) {
            const convention = this.detectConvention(collections.classNames);
            patterns.push({
                type: 'class',
                convention,
                confidence: this.calculateConfidence(collections.classNames, convention),
                samples: collections.classNames.slice(0, 5),
            });
        }

        // Interface names
        if (collections.interfaceNames.length > 0) {
            const convention = this.detectConvention(collections.interfaceNames);
            patterns.push({
                type: 'interface',
                convention,
                confidence: this.calculateConfidence(collections.interfaceNames, convention),
                samples: collections.interfaceNames.slice(0, 5),
            });
        }

        // Variable names
        if (collections.variableNames.length > 0) {
            const convention = this.detectConvention(collections.variableNames);
            patterns.push({
                type: 'variable',
                convention,
                confidence: this.calculateConfidence(collections.variableNames, convention),
                samples: collections.variableNames.slice(0, 5),
            });
        }

        // Constant names
        if (collections.constantNames.length > 0) {
            const convention = this.detectConvention(collections.constantNames);
            patterns.push({
                type: 'constant',
                convention,
                confidence: this.calculateConfidence(collections.constantNames, convention),
                samples: collections.constantNames.slice(0, 5),
            });
        }

        return patterns;
    }

    /**
     * Detect naming convention from a list of names
     */
    private detectConvention(names: string[]): 'camelCase' | 'PascalCase' | 'UPPER_CASE' | 'kebab-case' | 'snake_case' {
        const conventions = {
            camelCase: 0,
            PascalCase: 0,
            UPPER_CASE: 0,
            'kebab-case': 0,
            snake_case: 0,
        };

        for (const name of names) {
            if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
                conventions.PascalCase++;
            } else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) {
                conventions.camelCase++;
            } else if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
                conventions.UPPER_CASE++;
            } else if (/^[a-z][a-z0-9-]*$/.test(name)) {
                conventions['kebab-case']++;
            } else if (/^[a-z][a-z0-9_]*$/.test(name)) {
                conventions.snake_case++;
            }
        }

        // Return convention with highest count
        let maxCount = 0;
        let detected: keyof typeof conventions = 'camelCase';

        for (const [convention, count] of Object.entries(conventions)) {
            if (count > maxCount) {
                maxCount = count;
                detected = convention as keyof typeof conventions;
            }
        }

        return detected;
    }

    /**
     * Calculate confidence for a naming convention
     */
    private calculateConfidence(names: string[], convention: string): number {
        if (names.length === 0) return 0;

        let matches = 0;
        for (const name of names) {
            if (this.matchesConvention(name, convention)) {
                matches++;
            }
        }

        return matches / names.length;
    }

    /**
     * Check if name matches convention
     */
    private matchesConvention(name: string, convention: string): boolean {
        switch (convention) {
            case 'camelCase':
                return /^[a-z][a-zA-Z0-9]*$/.test(name);
            case 'PascalCase':
                return /^[A-Z][a-zA-Z0-9]*$/.test(name);
            case 'UPPER_CASE':
                return /^[A-Z][A-Z0-9_]*$/.test(name);
            case 'kebab-case':
                return /^[a-z][a-z0-9-]*$/.test(name);
            case 'snake_case':
                return /^[a-z][a-z0-9_]*$/.test(name);
            default:
                return false;
        }
    }

    /**
     * Extract file organization patterns
     */
    private extractFilePatterns(files: string[]): FilePattern {
        const fileNames = files.map(f => path.basename(f));
        const directories = files.map(f => path.dirname(f));

        // Common file name patterns
        const hasIndex = fileNames.some(f => f.startsWith('index.'));
        const hasDotTest = fileNames.some(f => f.includes('.test.') || f.includes('.spec.'));
        const hasTestDir = directories.some(d => d.includes('/test') || d.includes('/tests'));

        return {
            fileNamePattern: hasIndex ? 'index.*' : '*.ts',
            directoryPattern: this.findCommonDirectory(directories),
            testPattern: hasDotTest ? '*.test.ts' : hasTestDir ? 'tests/*.ts' : undefined,
        };
    }

    /**
     * Find common directory pattern
     */
    private findCommonDirectory(directories: string[]): string {
        if (directories.length === 0) return '';

        const parts = directories[0].split(path.sep);
        let commonParts = [...parts];

        for (let i = 1; i < directories.length; i++) {
            const currentParts = directories[i].split(path.sep);
            const newCommon: string[] = [];

            for (let j = 0; j < Math.min(commonParts.length, currentParts.length); j++) {
                if (commonParts[j] === currentParts[j]) {
                    newCommon.push(commonParts[j]);
                } else {
                    break;
                }
            }

            commonParts = newCommon;
            if (commonParts.length === 0) break;
        }

        return commonParts.join(path.sep) || '.';
    }

    /**
     * Extract common prefixes and suffixes
     */
    private extractAffixes(collections: {
        functionNames: string[];
        classNames: string[];
        interfaceNames: string[];
    }): { prefixes: string[]; suffixes: string[] } {
        const allNames = [
            ...collections.functionNames,
            ...collections.classNames,
            ...collections.interfaceNames,
        ];

        const prefixes = new Map<string, number>();
        const suffixes = new Map<string, number>();

        for (const name of allNames) {
            // Extract potential prefixes (3-6 chars, must start with capital or lowercase letter)
            if (name.length > 6) {
                for (let len = 3; len <= 6; len++) {
                    const prefix = name.slice(0, len);
                    // Must be a PascalCase start (e.g., Get, User) or camelCase start (e.g., get, user)
                    if (/^[A-Z][a-z]{2,}/.test(prefix) || /^[a-z]{3,}/.test(prefix)) {
                        prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
                    }
                }
            }

            // Extract potential suffixes (4-10 chars, must be meaningful word-like)
            if (name.length > 10) {
                // Try to find CamelCase boundaries for suffix extraction
                const camelMatches = name.match(/[A-Z][a-z]+/g);
                if (camelMatches && camelMatches.length > 1) {
                    // Extract last 1-2 CamelCase parts as potential suffix
                    const lastPart = camelMatches[camelMatches.length - 1];
                    suffixes.set(lastPart, (suffixes.get(lastPart) || 0) + 1);
                    
                    if (camelMatches.length > 2) {
                        const lastTwoParts = camelMatches.slice(-2).join('');
                        suffixes.set(lastTwoParts, (suffixes.get(lastTwoParts) || 0) + 1);
                    }
                }
            }
        }

        // Filter by frequency and return top results
        const topPrefixes = Array.from(prefixes.entries())
            .filter(([_, count]) => count >= this.config.minFrequency)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([prefix]) => prefix);

        const topSuffixes = Array.from(suffixes.entries())
            .filter(([_, count]) => count >= this.config.minFrequency)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([suffix]) => suffix);

        return {
            prefixes: topPrefixes,
            suffixes: topSuffixes,
        };
    }

    /**
     * Filter patterns by minimum frequency
     */
    private filterByFrequency<T extends { count: number }>(patterns: T[]): T[] {
        return patterns
            .filter(p => p.count >= this.config.minFrequency)
            .sort((a, b) => b.count - a.count);
    }

    /**
     * Get current configuration
     */
    public getConfig(): PatternExtractionConfig {
        return { ...this.config };
    }
}
