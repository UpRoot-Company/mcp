import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PatternExtractor, ProjectPatterns } from '../../generation/PatternExtractor.js';
import { IFileSystem } from '../../platform/FileSystem.js';

describe('PatternExtractor', () => {
    let mockFileSystem: IFileSystem;
    let extractor: PatternExtractor;

    beforeEach(() => {
        mockFileSystem = {
            readFile: jest.fn<() => Promise<string>>(),
            writeFile: jest.fn<() => Promise<void>>(),
            deleteFile: jest.fn<() => Promise<void>>(),
            exists: jest.fn<() => Promise<boolean>>(),
            readDir: jest.fn<() => Promise<string[]>>(),
            stat: jest.fn<() => Promise<{ isDirectory: () => boolean }>>(),
        } as unknown as IFileSystem;

        extractor = new PatternExtractor(mockFileSystem, '/test/root');
    });

    describe('Import Pattern Extraction', () => {
        it('should extract named import patterns', async () => {
            const fileContent = `
import { foo, bar } from 'moduleA';
import { baz } from 'moduleB';
import { foo, bar } from 'moduleA';
import { baz } from 'moduleB';
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            expect(patterns.imports).toHaveLength(2);
            
            const moduleAImport = patterns.imports.find(p => p.module === 'moduleA');
            expect(moduleAImport).toBeDefined();
            expect(moduleAImport?.style).toBe('named');
            expect(moduleAImport?.count).toBe(2);
            expect(moduleAImport?.namedImports).toEqual(['foo', 'bar']);
        });

        it('should extract default import patterns', async () => {
            const fileContent = `
import React from 'react';
import fs from 'fs';
import React from 'react';
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const reactImport = patterns.imports.find(p => p.module === 'react');
            expect(reactImport).toBeDefined();
            expect(reactImport?.style).toBe('default');
            expect(reactImport?.count).toBe(2);
            expect(reactImport?.alias).toBe('React');
        });

        it('should extract namespace import patterns', async () => {
            const fileContent = `
import * as path from 'path';
import * as fs from 'fs';
import * as path from 'path';
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const pathImport = patterns.imports.find(p => p.module === 'path');
            expect(pathImport).toBeDefined();
            expect(pathImport?.style).toBe('namespace');
            expect(pathImport?.count).toBe(2);
            expect(pathImport?.alias).toBe('path');
        });

        it('should extract side-effect import patterns', async () => {
            const fileContent = `
import 'reflect-metadata';
import './styles.css';
import 'reflect-metadata';
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const metadataImport = patterns.imports.find(p => p.module === 'reflect-metadata');
            expect(metadataImport).toBeDefined();
            expect(metadataImport?.style).toBe('side-effect');
            expect(metadataImport?.count).toBe(2);
        });

        it('should filter imports by minimum frequency', async () => {
            const fileContent = `
import { once } from 'moduleA';
import { twice } from 'moduleB';
import { twice } from 'moduleB';
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            // Default minFrequency is 2, so 'once' should be filtered out
            expect(patterns.imports).toHaveLength(1);
            expect(patterns.imports[0].module).toBe('moduleB');
        });
    });

    describe('Export Pattern Extraction', () => {
        it('should extract named export patterns', async () => {
            const fileContent = `
export { foo, bar };
export { baz };
export { foo, bar };
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const namedExport = patterns.exports.find(p => p.style === 'named');
            expect(namedExport).toBeDefined();
            expect(namedExport?.count).toBeGreaterThanOrEqual(2);
        });

        it('should extract default export patterns', async () => {
            const fileContent = `
export default class MyClass {}
export default function myFunc() {}
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const defaultExport = patterns.exports.find(p => p.style === 'default');
            expect(defaultExport).toBeDefined();
            expect(defaultExport?.count).toBe(2);
        });

        it('should extract namespace export patterns', async () => {
            const fileContent = `
export * from './moduleA';
export * from './moduleB';
export * from './moduleA';
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const namespaceExport = patterns.exports.find(p => p.style === 'namespace');
            expect(namespaceExport).toBeDefined();
            expect(namespaceExport?.count).toBeGreaterThanOrEqual(2);
        });
    });

    describe('Naming Convention Detection', () => {
        it('should detect camelCase for function names', async () => {
            const fileContent = `
function myFunction() {}
function anotherFunction() {}
function thirdFunction() {}
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const funcPattern = patterns.naming.find(p => p.type === 'function');
            expect(funcPattern).toBeDefined();
            expect(funcPattern?.convention).toBe('camelCase');
            expect(funcPattern?.confidence).toBeGreaterThan(0.9);
        });

        it('should detect PascalCase for class names', async () => {
            const fileContent = `
class MyClass {}
class AnotherClass {}
class ThirdClass {}
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const classPattern = patterns.naming.find(p => p.type === 'class');
            expect(classPattern).toBeDefined();
            expect(classPattern?.convention).toBe('PascalCase');
            expect(classPattern?.confidence).toBeGreaterThan(0.9);
        });

        it('should detect PascalCase for interface names', async () => {
            const fileContent = `
interface MyInterface {}
interface AnotherInterface {}
interface ThirdInterface {}
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const interfacePattern = patterns.naming.find(p => p.type === 'interface');
            expect(interfacePattern).toBeDefined();
            expect(interfacePattern?.convention).toBe('PascalCase');
            expect(interfacePattern?.confidence).toBeGreaterThan(0.9);
        });

        it('should detect UPPER_CASE for constants', async () => {
            const fileContent = `
const MY_CONSTANT = 1;
const ANOTHER_CONSTANT = 2;
const THIRD_CONSTANT = 3;
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const constantPattern = patterns.naming.find(p => p.type === 'constant');
            expect(constantPattern).toBeDefined();
            expect(constantPattern?.convention).toBe('UPPER_CASE');
            expect(constantPattern?.confidence).toBeGreaterThan(0.9);
        });

        it('should detect camelCase for variables', async () => {
            const fileContent = `
const myVariable = 1;
let anotherVariable = 2;
const thirdVariable = 3;
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const varPattern = patterns.naming.find(p => p.type === 'variable');
            expect(varPattern).toBeDefined();
            expect(varPattern?.convention).toBe('camelCase');
        });

        it('should include sample names', async () => {
            const fileContent = `
function sampleOne() {}
function sampleTwo() {}
function sampleThree() {}
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            const funcPattern = patterns.naming.find(p => p.type === 'function');
            expect(funcPattern?.samples).toBeDefined();
            expect(funcPattern?.samples.length).toBeGreaterThan(0);
            expect(funcPattern?.samples).toContain('sampleOne');
        });
    });

    describe('File Pattern Extraction', () => {
        it('should detect index file pattern', async () => {
            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue('');

            const patterns = await extractor.extractPatterns([
                '/test/src/index.ts',
                '/test/src/components/index.ts',
                '/test/src/utils/index.ts',
            ]);

            expect(patterns.fileOrg.fileNamePattern).toBe('index.*');
        });

        it('should detect test file pattern with .test suffix', async () => {
            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue('');

            const patterns = await extractor.extractPatterns([
                '/test/src/foo.test.ts',
                '/test/src/bar.test.ts',
            ]);

            expect(patterns.fileOrg.testPattern).toBe('*.test.ts');
        });

        it('should detect test file pattern with tests directory', async () => {
            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue('');

            const patterns = await extractor.extractPatterns([
                '/test/src/tests/foo.ts',
                '/test/src/tests/bar.ts',
            ]);

            expect(patterns.fileOrg.testPattern).toBe('tests/*.ts');
        });

        it('should find common directory pattern', async () => {
            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue('');

            const patterns = await extractor.extractPatterns([
                '/test/src/components/A.ts',
                '/test/src/components/B.ts',
                '/test/src/utils/C.ts',
            ]);

            expect(patterns.fileOrg.directoryPattern).toContain('src');
        });
    });

    describe('Prefix and Suffix Extraction', () => {
        it('should extract common prefixes', async () => {
            const fileContent = `
function getUserData() {}
function getUserId() {}
function getUserName() {}
class UserService {}
class UserRepository {}
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            // Should detect 'get' and 'User' as common prefixes
            expect(patterns.affixes.prefixes.length).toBeGreaterThan(0);
        });

        it('should extract common suffixes', async () => {
            const fileContent = `
class UserService {}
class DataService {}
class AuthService {}
class OrderService {}
interface UserRepository {}
interface DataRepository {}
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            // Should detect 'Service' and 'Repository' as common suffixes
            expect(patterns.affixes.suffixes.length).toBeGreaterThan(0);
            expect(patterns.affixes.suffixes).toContain('Service');
        });

        it('should filter affixes by minimum frequency', async () => {
            const fileContent = `
class OnceService {}
class TwiceHelper {}
class TwiceHelper {}
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/file1.ts']);

            // 'Service' appears once, should be filtered out
            // 'Helper' appears twice, should be included
            expect(patterns.affixes.suffixes).not.toContain('Service');
        });
    });

    describe('Configuration', () => {
        it('should respect maxFiles configuration', async () => {
            const customExtractor = new PatternExtractor(mockFileSystem, '/test/root', {
                maxFiles: 2,
            });

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue('');

            const files = ['/test/1.ts', '/test/2.ts', '/test/3.ts', '/test/4.ts'];
            await customExtractor.extractPatterns(files);

            // Should only read first 2 files
            expect(mockFileSystem.readFile).toHaveBeenCalledTimes(2);
        });

        it('should respect minFrequency configuration', async () => {
            const customExtractor = new PatternExtractor(mockFileSystem, '/test/root', {
                minFrequency: 3,
            });

            const fileContent = `
import { twice } from 'moduleA';
import { twice } from 'moduleA';
import { thrice } from 'moduleB';
import { thrice } from 'moduleB';
import { thrice } from 'moduleB';
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await customExtractor.extractPatterns(['/test/file1.ts']);

            // Only 'thrice' appears 3 times
            expect(patterns.imports).toHaveLength(1);
            expect(patterns.imports[0].module).toBe('moduleB');
        });

        it('should return configuration via getConfig', () => {
            const config = extractor.getConfig();

            expect(config.maxFiles).toBe(50);
            expect(config.extensions).toEqual(['.ts', '.tsx', '.js', '.jsx']);
            expect(config.minFrequency).toBe(2);
        });
    });

    describe('Error Handling', () => {
        it('should skip files that cannot be read', async () => {
            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>)
                .mockResolvedValueOnce('import { foo } from "moduleA";\nimport { foo } from "moduleA";')
                .mockRejectedValueOnce(new Error('File not found'))
                .mockResolvedValueOnce('import { bar } from "moduleB";\nimport { bar } from "moduleB";');

            const patterns = await extractor.extractPatterns([
                '/test/file1.ts',
                '/test/file2.ts',
                '/test/file3.ts',
            ]);

            // Should still extract patterns from files that could be read
            expect(patterns.imports.length).toBeGreaterThan(0);
        });
    });

    describe('Real-World Scenarios', () => {
        it('should extract patterns from React component files', async () => {
            const fileContent = `
import React from 'react';
import { useState, useEffect } from 'react';
import { useState, useEffect } from 'react';
import { MyComponent } from './components/MyComponent';

export interface Props {
    title: string;
    count: number;
}

export function myButton(props: Props) {
    const [isClicked, setIsClicked] = useState(false);
    
    return <button>{props.title}</button>;
}

export default myButton;
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/Button.tsx']);

            // Should detect React import patterns (named import appears 2 times)
            const reactImport = patterns.imports.find(p => p.module === 'react');
            expect(reactImport).toBeDefined();

            // Should detect PascalCase for interface
            const interfacePattern = patterns.naming.find(p => p.type === 'interface');
            expect(interfacePattern?.convention).toBe('PascalCase');

            // Should detect camelCase for function
            const funcPattern = patterns.naming.find(p => p.type === 'function');
            expect(funcPattern?.convention).toBe('camelCase');
        });

        it('should extract patterns from Node.js service files', async () => {
            const fileContent = `
import * as fs from 'fs';
import * as path from 'path';
import * as path from 'path';
import { DatabaseConnection } from './database';

export class UserService {
    private readonly db: DatabaseConnection;
    
    constructor(db: DatabaseConnection) {
        this.db = db;
    }
    
    async getUserById(id: string) {
        return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
    }
}

export default UserService;
            `;

            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue(fileContent);

            const patterns = await extractor.extractPatterns(['/test/UserService.ts']);

            // Should detect namespace imports (path appears 2 times)
            const namespaceImports = patterns.imports.filter(p => p.style === 'namespace');
            expect(namespaceImports.length).toBeGreaterThan(0);

            // Should detect PascalCase for class
            const classPattern = patterns.naming.find(p => p.type === 'class');
            expect(classPattern?.convention).toBe('PascalCase');

            // Should detect camelCase for methods
            const funcPattern = patterns.naming.find(p => p.type === 'function');
            if (funcPattern) {
                expect(funcPattern.convention).toBe('camelCase');
            }
        });
    });

    describe('Performance', () => {
        it('should handle large number of files efficiently', async () => {
            (mockFileSystem.readFile as jest.Mock<() => Promise<string>>).mockResolvedValue('import { foo } from "bar";');

            const files = Array.from({ length: 100 }, (_, i) => `/test/file${i}.ts`);

            const startTime = Date.now();
            await extractor.extractPatterns(files);
            const endTime = Date.now();

            // Should complete within reasonable time (< 1 second for 100 files)
            expect(endTime - startTime).toBeLessThan(1000);
        });
    });
});
