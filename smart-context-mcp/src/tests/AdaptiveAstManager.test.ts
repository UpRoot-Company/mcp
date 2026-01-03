import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AstManager } from '../ast/AstManager.js';
import { FeatureFlags } from '../config/FeatureFlags.js';
import { AnalysisRequest } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('AdaptiveAstManager', () => {
    let manager: AstManager;
    let tempDir: string;
    let previousFlags: Record<string, boolean>;
    
    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-manager-test-'));
        AstManager.resetForTesting();
        manager = AstManager.getInstance();
        await manager.init({ mode: 'test', rootPath: tempDir });
        
        // Enable adaptive flow for testing
        previousFlags = FeatureFlags.getAll();
        FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
        FeatureFlags.set(FeatureFlags.TOPOLOGY_SCANNER_ENABLED, true);
        FeatureFlags.set(FeatureFlags.UCG_ENABLED, true);
    });
    
    afterEach(async () => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        await AstManager.resetForTestingAsync();
        const currentKeys = Object.keys(FeatureFlags.getAll());
        for (const key of currentKeys) {
            FeatureFlags.set(key, previousFlags[key] ?? false);
        }
    });
    
    describe('LOD Management', () => {
        it('should ensure LOD level for a file', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, 'export const x = 1;');
            
            const request: AnalysisRequest = {
                path: testFile,
                minLOD: 1
            };
            
            const result = await manager.ensureLOD(request);
            
            expect(result.currentLOD).toBeGreaterThanOrEqual(1);
            expect(result.path).toBe(testFile);
        });
        
        it('should return correct promotion stats', async () => {
            const testFile = path.join(tempDir, 'stats.ts');
            fs.writeFileSync(testFile, 'export const y = 2;');
            
            await manager.ensureLOD({ path: testFile, minLOD: 1 });
            const stats = manager.promotionStats();
            
            expect(stats.l0_to_l1).toBeGreaterThan(0);
            expect(stats.total_files).toBeGreaterThan(0);
        });
    });
    
    describe('Feature Flag Disabled', () => {
        it('should fall back to full AST when adaptive flow is disabled', async () => {
            FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
            const testFile = path.join(tempDir, 'fallback.ts');
            fs.writeFileSync(testFile, 'const z = 3;');
            
            const request: AnalysisRequest = {
                path: testFile,
                minLOD: 1
            };
            
            const result = await manager.ensureLOD(request);
            
            expect(result.fallbackUsed).toBe(true);
            expect(result.currentLOD).toBe(3);
        });
    });

    describe('TopologyScanner integration', () => {
        it('should populate UCG topology data when enabled', async () => {
            const testFile = path.join(tempDir, 'graph.ts');
            fs.writeFileSync(testFile, 'import { helper } from "./dep";\nexport const value = helper();');
            const depFile = path.join(tempDir, 'dep.ts');
            fs.writeFileSync(depFile, 'export const helper = () => 42;');

            const result = await manager.ensureLOD({ path: testFile, minLOD: 1 });
            expect(result.fallbackUsed).toBe(false);
            const node = manager.getUCG().getNode(testFile);
            expect(node?.topology?.imports?.[0]?.source).toContain('./dep');
        });

        it('should mark fallback when TopologyScanner is disabled', async () => {
            FeatureFlags.set(FeatureFlags.TOPOLOGY_SCANNER_ENABLED, false);
            const testFile = path.join(tempDir, 'graph-fallback.ts');
            fs.writeFileSync(testFile, 'export const flag = true;');

            const result = await manager.ensureLOD({ path: testFile, minLOD: 1 });
            expect(result.fallbackUsed).toBe(true);
        });
    });
    
    describe('Backward Compatibility', () => {
        it('should not break existing parseFile() calls', async () => {
            const testFile = path.join(tempDir, 'compat.ts');
            const content = 'const x = 1;';
            const doc = await manager.parseFile(testFile, content);
            
            expect(doc).toBeDefined();
            expect(doc.rootNode).toBeDefined();
        });
    });
});
