import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AdaptiveFlowMetrics } from '../utils/AdaptiveFlowMetrics.js';
import { AdaptiveFlowReporter } from '../utils/AdaptiveFlowReporter.js';
import { AlertDispatcher } from '../utils/AlertDispatcher.js';

describe('AdaptiveFlowReporter alerts', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-alert-'));
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('dispatches alert payloads to NDJSON log', async () => {
        for (let i = 0; i < 10; i++) {
            AdaptiveFlowMetrics.recordTopologyScan(100, true);
        }
        AdaptiveFlowMetrics.captureUcgSnapshot({
            node_count: 1000,
            evictions: 0,
            cascade_invalidations: 0,
            memory_estimate_mb: 1000
        });

        const dispatcher = new AlertDispatcher({
            rootPath: tempDir,
            logDir: tempDir,
            severity: 'critical',
            label: 'test-env'
        });

        const reporter = new AdaptiveFlowReporter({
            rootPath: tempDir,
            enabled: true,
            alertThresholds: { topologySuccessRate: 0.95, ucgMemoryMb: 500 },
            onAlert: payload => dispatcher.dispatch(payload)
        });

        reporter.flush();
        await new Promise(resolve => setTimeout(resolve, 100));

        const logPath = path.join(tempDir, 'adaptive-flow-alerts.ndjson');
        expect(fs.existsSync(logPath)).toBe(true);
        const entries = fs.readFileSync(logPath, 'utf-8').trim().split(/\r?\n/);
        expect(entries.length).toBeGreaterThan(0);
        const record = JSON.parse(entries[0]);
        expect(record).toMatchObject({
            channel: 'adaptive-flow',
            severity: 'critical'
        });
        expect(['ucg-memory', 'topology-success-rate']).toContain(record.type);
    });
});
