import * as path from 'path';
import { AdaptiveFlowMetrics } from './AdaptiveFlowMetrics.js';

export type AdaptiveFlowAlertType = 'topology-success-rate' | 'ucg-memory' | 'l3-promotion-ratio';

export interface AlertThresholds {
    topologySuccessRate?: number;
    ucgMemoryMb?: number;
    l3PromotionRatio?: number;
}

export interface AdaptiveFlowReporterOptions {
    rootPath: string;
    exportDir?: string;
    exportIntervalMs?: number;
    enabled?: boolean;
    alertThresholds?: AlertThresholds;
    onAlert?: (payload: AdaptiveFlowAlertPayload) => void;
}

export interface AdaptiveFlowAlertPayload {
    type: AdaptiveFlowAlertType;
    message: string;
    metrics: ReturnType<typeof AdaptiveFlowMetrics.getMetrics>;
}

export class AdaptiveFlowReporter {
    private timer?: NodeJS.Timeout;
    private readonly options: AdaptiveFlowReporterOptions;

    constructor(options: AdaptiveFlowReporterOptions) {
        this.options = options;
    }

    start(): void {
        if (this.timer || this.options.enabled === false) {
            return;
        }
        const interval = this.resolveInterval();
        if (!interval) {
            return;
        }
        this.flush();
        this.timer = setInterval(() => {
            this.flush();
        }, interval);
        this.timer.unref?.();
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = undefined;
    }

    flush(): void {
        try {
            const metrics = AdaptiveFlowMetrics.getMetrics();
            const filePath = this.resolveExportPath();
            AdaptiveFlowMetrics.exportToFile(filePath);
            this.evaluateAlerts(metrics);
        } catch (error) {
            console.warn('[AdaptiveFlowReporter] Failed to export metrics:', error);
        }
    }

    private resolveInterval(): number | null {
        const raw = this.options.exportIntervalMs ?? Number(process.env.SMART_CONTEXT_METRICS_INTERVAL_MS ?? 60000);
        if (!Number.isFinite(raw) || raw <= 0) {
            return null;
        }
        return raw;
    }

    private resolveExportPath(): string {
        const dir = this.options.exportDir ?? process.env.SMART_CONTEXT_METRICS_DIR ?? path.join(this.options.rootPath, 'logs');
        const stamp = this.buildDateStamp(new Date());
        return path.join(dir, `adaptive-flow-${stamp}.json`);
    }

    private buildDateStamp(date: Date): string {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return `${year}${month}${day}`;
    }

    private evaluateAlerts(metrics: ReturnType<typeof AdaptiveFlowMetrics.getMetrics>): void {
        const thresholds = this.resolveThresholds();
        if (thresholds.topologySuccessRate !== undefined && metrics.topology_scanner.success_rate < thresholds.topologySuccessRate) {
            this.emitAlert('topology-success-rate', `Topology success rate ${metrics.topology_scanner.success_rate} < ${thresholds.topologySuccessRate}`, metrics);
        }
        if (thresholds.ucgMemoryMb !== undefined && metrics.ucg.memory_estimate_mb > thresholds.ucgMemoryMb) {
            this.emitAlert('ucg-memory', `UCG memory ${metrics.ucg.memory_estimate_mb}MB > ${thresholds.ucgMemoryMb}MB`, metrics);
        }
        if (thresholds.l3PromotionRatio !== undefined) {
            const totalPromotions = metrics.lod_promotions.l0_to_l1 + metrics.lod_promotions.l1_to_l2 + metrics.lod_promotions.l2_to_l3;
            if (totalPromotions > 0) {
                const l3Ratio = metrics.lod_promotions.l2_to_l3 / totalPromotions;
                if (l3Ratio > thresholds.l3PromotionRatio) {
                    this.emitAlert('l3-promotion-ratio', `LOD 3 promotion ratio ${l3Ratio.toFixed(3)} > ${thresholds.l3PromotionRatio}`, metrics);
                }
            }
        }
    }

    private resolveThresholds(): Required<AlertThresholds> {
        const defaults: Required<AlertThresholds> = {
            topologySuccessRate: 0.95,
            ucgMemoryMb: 500,
            l3PromotionRatio: 0.5
        };
        return {
            topologySuccessRate: this.pickThreshold('topologySuccessRate', defaults.topologySuccessRate),
            ucgMemoryMb: this.pickThreshold('ucgMemoryMb', defaults.ucgMemoryMb),
            l3PromotionRatio: this.pickThreshold('l3PromotionRatio', defaults.l3PromotionRatio)
        };
    }

    private pickThreshold<K extends keyof AlertThresholds>(key: K, fallback: number): number {
        const override = this.options.alertThresholds?.[key];
        if (override !== undefined) return override;
        const envKeyMap: Record<keyof AlertThresholds, string> = {
            topologySuccessRate: 'SMART_CONTEXT_TOPOLOGY_SUCCESS_MIN',
            ucgMemoryMb: 'SMART_CONTEXT_UCG_MEMORY_MAX_MB',
            l3PromotionRatio: 'SMART_CONTEXT_L3_PROMOTION_RATIO_MAX'
        };
        const raw = process.env[envKeyMap[key]];
        if (!raw) return fallback;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return fallback;
        return parsed;
    }

    private emitAlert(type: AdaptiveFlowAlertType, message: string, metrics: ReturnType<typeof AdaptiveFlowMetrics.getMetrics>): void {
        const payload: AdaptiveFlowAlertPayload = { type, message, metrics };
        if (typeof this.options.onAlert === 'function') {
            this.options.onAlert(payload);
        } else {
            console.warn(`[AdaptiveFlowReporter] ALERT (${type}) ${message}`);
        }
    }
}
