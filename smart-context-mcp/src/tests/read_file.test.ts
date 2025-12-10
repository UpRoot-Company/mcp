
import { SmartContextServer } from "../index.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AstManager } from "../ast/AstManager.js"; // Import AstManager
import { SmartFileProfile } from "../types.js";

describe('SmartContextServer - read_file', () => {
    let server: SmartContextServer;
    let testRootDir: string;
    let fileA_Path: string;
    let fileB_Path: string;
    let fileC_Path: string; // File with no dependencies

    const fileA_Content = `
import { someUtil } from './fileB';

class TestClassA {
    private name: string;
    constructor(name: string) {
        this.name = name;
    }
    public greet(message: string): string {
        // Complex logic here
        return \`Hello, \${this.name}! \${message}\`;
    }
}

export function helperFunctionA(): void {
    // Another complex function
    console.log('Helper A called');
}
`;

    const fileB_Content = `
export function someUtil(): string {
    return 'utility_value';
}

export const CONSTANT_B = 123; // Exported constant
`;

    const fileC_Content = `
// This file has no imports or exports
const isolatedValue = 'hello';

function doSomethingIsolated() {
    console.log(isolatedValue);
}
`;

    beforeEach(async () => {
        testRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-context-test-'));

        // Explicitly initialize AstManager and load languages for the shared AstManager instance
        await AstManager.getInstance().init();
        await AstManager.getInstance().warmup(['typescript', 'tsx', 'python']);
        
        // Mock rootPath to the temporary directory
        server = new SmartContextServer(testRootDir);

        // Create test files
        fs.mkdirSync(path.join(testRootDir, 'src'), { recursive: true });
        fileA_Path = path.join(testRootDir, 'src', 'fileA.ts');
        fileB_Path = path.join(testRootDir, 'src', 'fileB.ts');
        fileC_Path = path.join(testRootDir, 'src', 'fileC.ts');

        fs.writeFileSync(fileA_Path, fileA_Content);
        fs.writeFileSync(fileB_Path, fileB_Content);
        fs.writeFileSync(fileC_Path, fileC_Content);

        // Ensure DependencyGraph is built for tests
        await (server as any).dependencyGraph.build();
    });

    afterEach(() => {
        fs.rmSync(testRootDir, { recursive: true, force: true });
    });

    it('should return raw content when full: true is provided', async () => {
        const args = { filePath: path.relative(testRootDir, fileA_Path), full: true };
        const response = await (server as any).handleCallTool('read_file', args);

        expect(response.content[0].text).toBe(fileA_Content);
    });

    it('should return a Smart File Profile by default (full: false)', async () => {
        const args = { filePath: path.relative(testRootDir, fileA_Path) };
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        expect(profile.metadata.relativePath).toBe('src/fileA.ts');
        expect(profile.metadata.newlineStyle).toBeDefined();
        expect(profile.metadata.indentSize).toBeGreaterThan(0);
        expect(profile.usage.outgoingFiles).toContain('src/fileB.ts');
        expect(profile.usage.incomingFiles).toEqual([]);
        expect(profile.structure.skeleton).toContain('class TestClassA');
        expect(profile.guidance.readFullHint.length).toBeGreaterThan(0);
    });

    it('should correctly display metadata in Smart File Profile', async () => {
        const args = { filePath: path.relative(testRootDir, fileA_Path) };
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        const stats = fs.statSync(fileA_Path);
        const lineCount = fileA_Content.split('\n').length;

        expect(profile.metadata.relativePath).toBe('src/fileA.ts');
        expect(profile.metadata.sizeBytes).toBe(stats.size);
        expect(profile.metadata.lineCount).toBe(lineCount);
        expect(profile.metadata.language).toBe('ts');
        expect(profile.metadata.newlineStyle).toBe('lf');
    });

    it('should correctly display outgoing dependencies in Smart File Profile', async () => {
        const args = { filePath: path.relative(testRootDir, fileA_Path) };
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        expect(profile.usage.outgoingFiles).toContain('src/fileB.ts');
    });

    it('should correctly display incoming references in Smart File Profile', async () => {
        const args = { filePath: path.relative(testRootDir, fileB_Path) }; // fileB is imported by fileA
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        expect(profile.usage.incomingFiles).toContain('src/fileA.ts');
    });

    it('should display "None" for relationships if no dependencies/references', async () => {
        const args = { filePath: path.relative(testRootDir, fileC_Path) };
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        expect(profile.usage.outgoingFiles).toEqual([]);
        expect(profile.usage.incomingFiles).toEqual([]);
    });

    it('should correctly display the skeleton with hidden implementation', async () => {
        const args = { filePath: path.relative(testRootDir, fileA_Path) };
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        expect(profile.structure.skeleton).toContain('class TestClassA {');
        expect(profile.structure.skeleton).toContain('constructor(name: string) { /* ... implementation hidden ... */ }');
        expect(profile.structure.skeleton).toContain('public greet(message: string): string { /* ... implementation hidden ... */ }');
        expect(profile.structure.skeleton).toContain('export function helperFunctionA(): void { /* ... implementation hidden ... */ }');
    });

    it('should handle non-existent file gracefully', async () => {
        const nonExistentPath = path.relative(testRootDir, path.join(testRootDir, 'src', 'nonExistent.ts'));
        const args = { filePath: nonExistentPath };
        const response = await (server as any).handleCallTool('read_file', args);

        expect(response.isError).toBe(true);
        // Expecting the JSON error output now
        expect(response.content[0].text).toContain('{"errorCode":"InternalError","message":"ENOENT: no such file or directory');
    });

    it('should handle empty file correctly for Smart File Profile', async () => {
        const emptyFilePath = path.join(testRootDir, 'src', 'empty.ts');
        fs.writeFileSync(emptyFilePath, '');
        
        const args = { filePath: path.relative(testRootDir, emptyFilePath) };
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        expect(profile.metadata.relativePath).toBe('src/empty.ts');
        expect(profile.metadata.lineCount).toBe(0);
        expect(profile.usage.outgoingFiles).toEqual([]);
        expect(typeof profile.structure.skeleton).toBe('string');
        expect(profile.structure.symbols).toHaveLength(0);
    });

    it('should handle skeleton generation failure gracefully for small files', async () => {
        const brokenFilePath = path.join(testRootDir, 'src', 'broken.ts');
        // Malformed TypeScript content that will break AST parsing
        const brokenContent = `
        class MyClass {
            method( { // syntax error
                console.log('body');
            }
        }
        `;
        fs.writeFileSync(brokenFilePath, brokenContent);

        // Temporarily override generateSkeleton to simulate failure more directly if needed,
        // but for now, rely on actual AST parsing failure
        const args = { filePath: path.relative(testRootDir, brokenFilePath) };
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        expect(profile.structure.skeleton).toContain('Skeleton generation failed');
        expect(profile.structure.skeleton).toContain('class MyClass');
    });

    it('should handle skeleton generation failure gracefully for large files', async () => {
        const largeBrokenFilePath = path.join(testRootDir, 'src', 'large_broken.ts');
        const largeBrokenContent = 'a'.repeat(6000) + `
        class MyClass {
            method( { // syntax error
                console.log('body');
            }
        }
        `; // > 5000 chars

        fs.writeFileSync(largeBrokenFilePath, largeBrokenContent);

        const args = { filePath: path.relative(testRootDir, largeBrokenFilePath) };
        const response = await (server as any).handleCallTool('read_file', args);
        const profile: SmartFileProfile = JSON.parse(response.content[0].text);

        expect(profile.structure.skeleton).toContain('Skeleton generation failed');
        expect(profile.structure.skeleton).not.toContain(largeBrokenContent); // Should NOT contain the full content
    });
});
