import { describe, it, expect, beforeEach } from '@jest/globals';
import { FeatureFlags } from '../config/FeatureFlags.js';

describe('FeatureFlags rollout context', () => {
    beforeEach(() => {
        FeatureFlags.resetForTesting();
    });

    it('respects canary allow list when context matches', () => {
        FeatureFlags.addCanaryUsers(['user-123']);
        FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true, 'canary');

        const enabled = FeatureFlags.withContext({ userId: 'user-123' }, () =>
            FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)
        );
        const disabled = FeatureFlags.withContext({ userId: 'someone-else' }, () =>
            FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)
        );

        expect(enabled).toBe(true);
        expect(disabled).toBe(false);
    });

    it('defaults to disabled for canary flags without user context', () => {
        FeatureFlags.addCanaryUsers(['user-123']);
        FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true, 'canary');
        expect(FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)).toBe(false);
    });

    it('propagates beta cohorts across async boundaries', async () => {
        FeatureFlags.setBetaPercent(100);
        FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true, 'beta');

        const result = await FeatureFlags.withContext({ userId: 'beta-user' }, async () => {
            return new Promise<boolean>((resolve) => {
                setTimeout(() => {
                    resolve(FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED));
                }, 5);
            });
        });

        expect(result).toBe(true);
    });
});
