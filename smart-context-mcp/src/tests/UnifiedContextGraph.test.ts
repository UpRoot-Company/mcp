import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { UnifiedContextGraph } from '../orchestration/context/UnifiedContextGraph.js';
import { FeatureFlags } from '../config/FeatureFlags.js';
import { AstManager } from '../ast/AstManager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('UnifiedContextGraph', () => {
    let ucg: UnifiedContextGraph;
    let tempDir: string;
    
    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucg-test-'));
        ucg = new UnifiedContextGraph(tempDir);
        
        // Enable necessary flags
        FeatureFlags.set(FeatureFlags.TOPOLOGY_SCANNER_ENABLED, true);
        FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
        
        AstManager.resetForTesting();
        const manager = AstManager.getInstance();
        await manager.init({ mode: 'test', rootPath: tempDir });
    });
    
    afterEach(() => {
        ucg.clear();
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        AstManager.resetForTesting();
    });
    
    describe('LOD Promotion', () => {
        it('should promote file from LOD 0 to LOD 1', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, 'import { foo } from "./bar";\nexport const baz = 1;');
            
            const result = await ucg.ensureLOD({ path: testFile, minLOD: 1 });
            
            expect(result.promoted).toBe(true);
            expect(result.currentLOD).toBe(1);
            
            const node = ucg.getNode(testFile);
            expect(node?.topology).toBeDefined();
            expect(node?.lod).toBe(1);
        });
        
        it('should promote incrementally up to LOD 3', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, 'export const x = 1;');
            
            const result = await ucg.ensureLOD({ path: testFile, minLOD: 3 });
            
            expect(result.currentLOD).toBe(3);
            const node = ucg.getNode(testFile);
            expect(node?.topology).toBeDefined(); // LOD 1
            expect(node?.skeleton).toBeDefined(); // LOD 2
            expect(node?.astDocId).toBeDefined();  // LOD 3
        });
    });
    
    describe('Dependency Tracking', () => {
        it('should build dependency edges at LOD 1', async () => {
            const fileA = path.join(tempDir, 'a.ts');
            const fileB = path.join(tempDir, 'b.ts');
            fs.writeFileSync(fileA, 'import { b } from "./b";');
            fs.writeFileSync(fileB, 'export const b = 1;');
            
            await ucg.ensureLOD({ path: fileA, minLOD: 1 });
            
            const nodeA = ucg.getNode(fileA);
            expect(nodeA?.dependencies.has(fileB)).toBe(true);
            
            const nodeB = ucg.getNode(fileB);
            expect(nodeB?.dependents.has(fileA)).toBe(true);
        });
    });
    
    describe('Invalidation', () => {
        it('should downgrade node to LOD 0 on invalidation', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, 'export const x = 1;');
            
            await ucg.ensureLOD({ path: testFile, minLOD: 2 });
            ucg.invalidate(testFile, false);
            
            const node = ucg.getNode(testFile);
            expect(node?.lod).toBe(0);
            expect(node?.skeleton).toBeUndefined();
        });
        
        it('should cascade invalidation to dependents', async () => {
            const fileA = path.join(tempDir, 'a.ts');
            const fileB = path.join(tempDir, 'b.ts');
            fs.writeFileSync(fileA, 'import { b } from "./b";');
            fs.writeFileSync(fileB, 'export const b = 1;');
            
            await ucg.ensureLOD({ path: fileA, minLOD: 2 });
            await ucg.ensureLOD({ path: fileB, minLOD: 2 });
            
            // Invalidate B, should downgrade A to LOD 1 (keep topology, drop structure)
            ucg.invalidate(fileB, true);
            
            const nodeA = ucg.getNode(fileA);
            expect(nodeA?.lod).toBe(1);
            
            const nodeB = ucg.getNode(fileB);
            expect(nodeB?.lod).toBe(0);
        });
    });
    
    describe('LRU Eviction', () => {
        it('should evict least recently used nodes', async () => {
            const smallUcg = new UnifiedContextGraph(tempDir, 2); // Max 2 nodes
            const file1 = path.join(tempDir, '1.ts');
            const file2 = path.join(tempDir, '2.ts');
            const file3 = path.join(tempDir, '3.ts');
            fs.writeFileSync(file1, ''); fs.writeFileSync(file2, ''); fs.writeFileSync(file3, '');
            
            await smallUcg.ensureLOD({ path: file1, minLOD: 1 });
            await smallUcg.ensureLOD({ path: file2, minLOD: 1 });
            await smallUcg.ensureLOD({ path: file3, minLOD: 1 }); // Should evict file1
            
            expect(smallUcg.getNode(file1)).toBeUndefined();
            expect(smallUcg.getNode(file2)).toBeDefined();
            expect(smallUcg.getNode(file3)).toBeDefined();
        });
    });
});
