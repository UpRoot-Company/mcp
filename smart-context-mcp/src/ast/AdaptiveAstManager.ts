import { LOD_LEVEL, AnalysisRequest, LODResult, LODPromotionStats } from '../types.js';
// import { ContextNode } from '../orchestration/context/ContextNode.js'; // Will create in Phase 2
type ContextNode = any;

/**
 * Adaptive AST Manager interface supporting granular LOD-based analysis.
 * Extends traditional AstManager with lazy evaluation and LOD promotion.
 */
export interface AdaptiveAstManager {
    /**
     * Ensures a file is analyzed to at least the requested LOD level.
     * Performs lazy evaluation: only promotes if current LOD < requested LOD.
     * 
     * @param request - Analysis request with path and minimum LOD
     * @returns LODResult with promotion details
     * @throws Error if file doesn't exist or analysis fails
     */
    ensureLOD(request: AnalysisRequest): Promise<LODResult>;
    
    /**
     * Retrieves the UCG node for a file.
     * Does NOT trigger analysis. Returns undefined if file not in graph.
     * 
     * @param path - Absolute file path
     * @returns ContextNode or undefined
     */
    getFileNode(path: string): ContextNode | undefined;
    
    /**
     * Gets current LOD level for a file without triggering promotion.
     * 
     * @param path - Absolute file path
     * @returns Current LOD level (0-3), or 0 if file not tracked
     */
    getCurrentLOD(path: string): LOD_LEVEL;
    
    /**
     * Returns statistics about LOD promotions since server start.
     * Useful for monitoring and optimization.
     * 
     * @returns LODPromotionStats object
     */
    promotionStats(): LODPromotionStats;
    
    /**
     * Forces a file to be analyzed with full AST parsing (LOD 3).
     * Bypasses TopologyScanner even for LOD 1.
     * Use when regex extraction is known to be unreliable for a file.
     * 
     * @param path - Absolute file path
     * @returns LODResult with fallbackUsed: true
     */
    fallbackToFullAST(path: string): Promise<LODResult>;
    
    /**
     * Invalidates a file's LOD state, downgrading it to LOD 0.
     * Optionally cascades to dependent files.
     * 
     * @param path - Absolute file path
     * @param cascade - If true, downgrades dependent files to LOD 1
     */
    invalidate(path: string, cascade?: boolean): void;
}
