import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AstManager } from '../ast/AstManager.js';
import { FeatureFlags } from '../config/FeatureFlags.js';
import { AnalysisRequest, LOD_LEVEL } from '../types.js';

describe('AdaptiveAstManager', () => {
    let manager: AstManager;
    
    beforeEach(async () => {
        AstManager.resetForTesting();
        manager = AstManager.getInstance();
        await manager.init({ mode: 'test', rootPath: process.cwd() });
    });
    
    afterEach(() => {
        AstManager.resetForTesting();
        FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
    });
    
    describe('Feature Flag Disabled', () => {
        it('should fall back to full AST when adaptive flow is disabled', async () => {
            FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
            
            const request: AnalysisRequest = {
                path: 'test.ts',
                minLOD: 1
            };
            
            const result = await manager.ensureLOD(request);
            
            expect(result.fallbackUsed).toBe(true);
            expect(result.currentLOD).toBe(3); // Always promotes to LOD 3
        });
        
        it('should return LOD 0 for getCurrentLOD when disabled', () => {
            FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
            
            const lod = manager.getCurrentLOD('test.ts');
            
            expect(lod).toBe(0);
        });
    });
    
    describe('Promotion Stats', () => {
        it('should return initial stats with zero counts', () => {
            const stats = manager.promotionStats();
            
            expect(stats.l0_to_l1).toBe(0);
            expect(stats.l1_to_l2).toBe(0);
            expect(stats.l2_to_l3).toBe(0);
            expect(stats.fallback_rate).toBe(0);
            expect(stats.total_files).toBe(0);
        });
    });
    
    describe('Backward Compatibility', () => {
        it('should not break existing parseFile() calls', async () => {
            const content = 'const x = 1;';
            const doc = await manager.parseFile('test.ts', content);
            
            expect(doc).toBeDefined();
            expect(doc.rootNode).toBeDefined();
        });
    });
    
    describe('Error Handling', () => {
        it('should throw error for ensureLOD when not implemented (Phase 1)', async () => {
            FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
            
            const request: AnalysisRequest = {
                path: 'test.ts',
                minLOD: 1
            };
            
            await expect(manager.ensureLOD(request)).rejects.toThrow('not implemented');
        });
    });
});
