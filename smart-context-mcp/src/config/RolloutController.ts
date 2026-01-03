import { FeatureFlags, RolloutMode } from './FeatureFlags.js';

interface FlagPreset {
    flag: string;
    enabled: boolean;
    mode?: RolloutMode;
}

interface RolloutPreset {
    description: string;
    flags: FlagPreset[];
}

const PRESETS: Record<string, RolloutPreset> = {
    legacy: {
        description: 'Legacy engines only (Adaptive Flow disabled)',
        flags: [
            { flag: FeatureFlags.ADAPTIVE_FLOW_ENABLED, enabled: false },
            { flag: FeatureFlags.TOPOLOGY_SCANNER_ENABLED, enabled: false },
            { flag: FeatureFlags.UCG_ENABLED, enabled: false },
            { flag: FeatureFlags.DUAL_WRITE_VALIDATION, enabled: false }
        ]
    },
    shadow: {
        description: 'Shadow mode populates UCG but keeps legacy serving responses',
        flags: [
            { flag: FeatureFlags.ADAPTIVE_FLOW_ENABLED, enabled: false },
            { flag: FeatureFlags.TOPOLOGY_SCANNER_ENABLED, enabled: true, mode: 'on' },
            { flag: FeatureFlags.UCG_ENABLED, enabled: true, mode: 'on' },
            { flag: FeatureFlags.DUAL_WRITE_VALIDATION, enabled: true, mode: 'on' }
        ]
    },
    canary: {
        description: 'Adaptive Flow enabled for explicit allow list',
        flags: [
            { flag: FeatureFlags.ADAPTIVE_FLOW_ENABLED, enabled: true, mode: 'canary' },
            { flag: FeatureFlags.TOPOLOGY_SCANNER_ENABLED, enabled: true, mode: 'canary' },
            { flag: FeatureFlags.UCG_ENABLED, enabled: true, mode: 'canary' },
            { flag: FeatureFlags.DUAL_WRITE_VALIDATION, enabled: true, mode: 'on' }
        ]
    },
    beta: {
        description: 'Adaptive Flow enabled for beta cohort (default 10%)',
        flags: [
            { flag: FeatureFlags.ADAPTIVE_FLOW_ENABLED, enabled: true, mode: 'beta' },
            { flag: FeatureFlags.TOPOLOGY_SCANNER_ENABLED, enabled: true, mode: 'beta' },
            { flag: FeatureFlags.UCG_ENABLED, enabled: true, mode: 'beta' },
            { flag: FeatureFlags.DUAL_WRITE_VALIDATION, enabled: true, mode: 'on' }
        ]
    },
    full: {
        description: 'Adaptive Flow enabled for 100% of traffic',
        flags: [
            { flag: FeatureFlags.ADAPTIVE_FLOW_ENABLED, enabled: true, mode: 'full' },
            { flag: FeatureFlags.TOPOLOGY_SCANNER_ENABLED, enabled: true, mode: 'full' },
            { flag: FeatureFlags.UCG_ENABLED, enabled: true, mode: 'full' },
            { flag: FeatureFlags.DUAL_WRITE_VALIDATION, enabled: false }
        ]
    }
};

export class RolloutController {
    static applyFromEnv(): void {
        const presetKey = (process.env.SMART_CONTEXT_ROLLOUT_MODE ?? process.env.SMART_CONTEXT_ROLLOUT_PHASE ?? 'full').trim().toLowerCase();
        const preset = PRESETS[presetKey];
        if (!preset) {
            console.warn(`[RolloutController] Unknown rollout preset "${presetKey}"`);
            return;
        }

        if (!this.shouldApplyPreset()) {
            console.warn(`[RolloutController] Preset "${presetKey}" skipped because manual flag overrides are in effect.`);
            return;
        }

        for (const flag of preset.flags) {
            FeatureFlags.set(flag.flag, flag.enabled, flag.mode ?? (flag.enabled ? 'on' : 'off'));
        }

        const canaryEnv = process.env.SMART_CONTEXT_ROLLOUT_CANARY_USERS ?? process.env.SMART_CONTEXT_CANARY_USERS;
        if (canaryEnv) {
            FeatureFlags.addCanaryUsers(canaryEnv.split(',').map(value => value.trim()).filter(Boolean));
        }

        const betaEnv = process.env.SMART_CONTEXT_ROLLOUT_BETA_PERCENT ?? process.env.SMART_CONTEXT_BETA_PERCENT;
        if (betaEnv) {
            const parsed = Number(betaEnv);
            if (Number.isFinite(parsed)) {
                FeatureFlags.setBetaPercent(parsed);
            }
        }

        console.log(`[RolloutController] Applied rollout preset "${presetKey}" (${preset.description})`);
    }

    private static shouldApplyPreset(): boolean {
        if (process.env.SMART_CONTEXT_ROLLOUT_FORCE === 'true') {
            return true;
        }
        const manualEnvOverrides = [
            'SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED',
            'SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED',
            'SMART_CONTEXT_UCG_ENABLED'
        ];
        return manualEnvOverrides.every(key => !process.env[key]);
    }
}
