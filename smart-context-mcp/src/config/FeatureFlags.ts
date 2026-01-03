import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export type RolloutMode = 'off' | 'on' | 'canary' | 'beta' | 'full';

export interface FeatureFlagContext {
    userId?: string;
}

/**
 * Feature flags for gradual rollout and A/B testing.
 * Flags can be controlled via environment variables or runtime config.
 */
export class FeatureFlags {
    private static flags: Map<string, boolean> = new Map();
    private static modes: Map<string, RolloutMode> = new Map();
    private static canaryUsers: Set<string> = new Set();
    private static betaPercent = 10;
    private static contextStorage = new AsyncLocalStorage<FeatureFlagContext>();
    
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
        this.canaryUsers = this.parseCanaryUsers(process.env.SMART_CONTEXT_CANARY_USERS);
        this.betaPercent = this.parseBetaPercent(process.env.SMART_CONTEXT_BETA_PERCENT);

        this.applyEnvFlag(this.ADAPTIVE_FLOW_ENABLED, process.env.SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED);
        this.applyEnvFlag(this.TOPOLOGY_SCANNER_ENABLED, process.env.SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED);
        this.applyEnvFlag(this.UCG_ENABLED, process.env.SMART_CONTEXT_UCG_ENABLED);
        this.applyEnvFlag(this.DUAL_WRITE_VALIDATION, process.env.SMART_CONTEXT_DUAL_WRITE_VALIDATION);

        console.log('[FeatureFlags] Initialized:', this.debugState());
    }
    
    static isEnabled(flag: string, context?: FeatureFlagContext): boolean {
        const enabled = this.flags.get(flag) ?? false;
        const mode = this.modes.get(flag) ?? (enabled ? 'on' : 'off');
        if (!enabled && mode !== 'canary' && mode !== 'beta') {
            return false;
        }

        const userId = context?.userId ?? this.contextStorage.getStore()?.userId;
        if (mode === 'canary') {
            if (!userId) return false;
            return this.isCanaryUser(userId);
        }
        if (mode === 'beta') {
            if (!userId) return false;
            return this.isInBetaCohort(userId);
        }
        return enabled;
    }
    
    static set(flag: string, enabled: boolean, mode?: RolloutMode): void {
        this.flags.set(flag, enabled);
        this.modes.set(flag, mode ?? (enabled ? 'on' : 'off'));
    }

    static withContext<T>(context: FeatureFlagContext | undefined, fn: () => T): T {
        if (!this.contextStorage) {
            return fn();
        }
        return this.contextStorage.run(context ?? {}, fn);
    }

    static getContext(): FeatureFlagContext | undefined {
        return this.contextStorage.getStore();
    }
    
    static getAll(): Record<string, boolean> {
        return Object.fromEntries(this.flags);
    }

    static getMode(flag: string): RolloutMode {
        return this.modes.get(flag) ?? 'off';
    }

    private static applyEnvFlag(flag: string, rawValue: string | undefined): void {
        const { enabled, mode } = this.parseFlagState(rawValue);
        this.flags.set(flag, enabled);
        this.modes.set(flag, mode);
    }

    private static parseFlagState(rawValue: string | undefined): { enabled: boolean; mode: RolloutMode } {
        if (!rawValue) {
            return { enabled: false, mode: 'off' };
        }
        const [modePart, payload] = rawValue.split(':', 2);
        const normalized = modePart.trim().toLowerCase();
        switch (normalized) {
            case 'true':
            case '1':
            case 'on':
                return { enabled: true, mode: 'on' };
            case 'full':
                return { enabled: true, mode: 'full' };
            case 'canary':
                if (payload) {
                    this.addCanaryUsers(payload.split(',').map(value => value.trim()).filter(Boolean));
                }
                return { enabled: true, mode: 'canary' };
            case 'beta':
                if (payload) {
                    this.setBetaPercent(this.parseBetaPercent(payload));
                }
                return { enabled: true, mode: 'beta' };
            case 'false':
            case '0':
            case 'off':
                return { enabled: false, mode: 'off' };
            default:
                return { enabled: rawValue === 'true', mode: rawValue === 'true' ? 'on' : 'off' };
        }
    }

    private static parseCanaryUsers(raw?: string): Set<string> {
        const users = new Set<string>();
        if (!raw) return users;
        raw.split(',').map(value => value.trim()).filter(Boolean).forEach(user => users.add(user));
        return users;
    }

    private static parseBetaPercent(raw?: string): number {
        if (!raw) return this.betaPercent || 10;
        const value = Number(raw);
        if (!Number.isFinite(value)) return this.betaPercent || 10;
        return Math.max(0, Math.min(100, value));
    }

    private static isCanaryUser(userId: string): boolean {
        if (this.canaryUsers.size === 0) return false;
        return this.canaryUsers.has(userId);
    }

    private static isInBetaCohort(userId: string): boolean {
        if (this.betaPercent <= 0) return false;
        if (this.betaPercent >= 100) return true;
        const hash = createHash('sha1').update(userId).digest('hex');
        const value = parseInt(hash.slice(0, 8), 16);
        const percent = value % 10000;
        return percent / 100 < this.betaPercent;
    }

    static addCanaryUsers(users: Iterable<string>): void {
        for (const user of users) {
            const normalized = user?.trim();
            if (normalized) {
                this.canaryUsers.add(normalized);
            }
        }
    }

    static setBetaPercent(percent: number): void {
        if (!Number.isFinite(percent)) return;
        this.betaPercent = Math.max(0, Math.min(100, percent));
    }

    static resetForTesting(): void {
        this.flags.clear();
        this.modes.clear();
        this.canaryUsers.clear();
        this.betaPercent = 10;
    }

    private static debugState(): Record<string, { enabled: boolean; mode: RolloutMode }> {
        const entries: Array<[string, { enabled: boolean; mode: RolloutMode }]> = [];
        for (const [flag, enabled] of this.flags.entries()) {
            entries.push([flag, { enabled, mode: this.modes.get(flag) ?? 'off' }]);
        }
        return Object.fromEntries(entries);
    }
}

// Auto-initialize on module load
FeatureFlags.initialize();
