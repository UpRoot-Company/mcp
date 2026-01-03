/**
 * Feature flags for gradual rollout and A/B testing.
 * Flags can be controlled via environment variables or runtime config.
 */
export class FeatureFlags {
    private static flags: Map<string, boolean> = new Map();
    
    /**
     * Enables the Adaptive Flow architecture (LOD + UCG).
     * Default: false (disabled)
     * Env var: SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED
     */
    static ADAPTIVE_FLOW_ENABLED = 'adaptive_flow_enabled';
    
    /**
     * Enables TopologyScanner for LOD 1 extraction.
     * Default: false (uses full AST fallback)
     * Env var: SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED
     */
    static TOPOLOGY_SCANNER_ENABLED = 'topology_scanner_enabled';
    
    /**
     * Enables Unified Context Graph state management.
     * Default: false (uses legacy caches)
     * Env var: SMART_CONTEXT_UCG_ENABLED
     */
    static UCG_ENABLED = 'ucg_enabled';
    
    /**
     * Enables dual-write validation (writes to both UCG and legacy caches).
     * Default: false
     * Env var: SMART_CONTEXT_DUAL_WRITE_VALIDATION
     */
    static DUAL_WRITE_VALIDATION = 'dual_write_validation';
    
    static initialize(): void {
        // Read from environment variables
        this.set(this.ADAPTIVE_FLOW_ENABLED, process.env.SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED === 'true');
        this.set(this.TOPOLOGY_SCANNER_ENABLED, process.env.SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED === 'true');
        this.set(this.UCG_ENABLED, process.env.SMART_CONTEXT_UCG_ENABLED === 'true');
        this.set(this.DUAL_WRITE_VALIDATION, process.env.SMART_CONTEXT_DUAL_WRITE_VALIDATION === 'true');
        
        console.log('[FeatureFlags] Initialized:', Object.fromEntries(this.flags));
    }
    
    static isEnabled(flag: string): boolean {
        return this.flags.get(flag) ?? false;
    }
    
    static set(flag: string, enabled: boolean): void {
        this.flags.set(flag, enabled);
    }
    
    static getAll(): Record<string, boolean> {
        return Object.fromEntries(this.flags);
    }
}

// Auto-initialize on module load
FeatureFlags.initialize();
