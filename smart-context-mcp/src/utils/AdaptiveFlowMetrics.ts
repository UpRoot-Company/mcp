import * as fs from 'fs';
import * as path from 'path';

interface TopologyMetrics {
    success_count: number;
    fallback_count: number;
    total_time_ms: number;
}

interface GraphMetrics {
    node_count: number;
    evictions: number;
    cascade_invalidations: number;
    memory_estimate_mb: number;
}

interface MetricsSnapshot {
    lod_promotions: {
        l0_to_l1: number;
        l1_to_l2: number;
        l2_to_l3: number;
    };
    topology_scanner: TopologyMetrics;
    ucg: GraphMetrics;
}

export class AdaptiveFlowMetrics {
    private static metrics: MetricsSnapshot = {
        lod_promotions: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 },
        topology_scanner: { success_count: 0, fallback_count: 0, total_time_ms: 0 },
        ucg: { node_count: 0, evictions: 0, cascade_invalidations: 0, memory_estimate_mb: 0 }
    };

    static recordPromotion(from: number, to: number): void {
        if (from === to) return;
        if (from <= 0 && to >= 1) this.metrics.lod_promotions.l0_to_l1++;
        if (from <= 1 && to >= 2) this.metrics.lod_promotions.l1_to_l2++;
        if (from <= 2 && to >= 3) this.metrics.lod_promotions.l2_to_l3++;
    }

    static recordTopologyScan(durationMs: number, fallbackUsed: boolean): void {
        if (fallbackUsed) {
            this.metrics.topology_scanner.fallback_count++;
        } else {
            this.metrics.topology_scanner.success_count++;
        }
        this.metrics.topology_scanner.total_time_ms += durationMs;
    }

    static captureUcgSnapshot(snapshot: GraphMetrics): void {
        this.metrics.ucg = { ...snapshot };
    }

    static getMetrics() {
        const totalScans = this.metrics.topology_scanner.success_count + this.metrics.topology_scanner.fallback_count;
        const avgDuration = totalScans > 0 ? this.metrics.topology_scanner.total_time_ms / totalScans : 0;
        const successRate = totalScans > 0 ? this.metrics.topology_scanner.success_count / totalScans : 0;
        const fallbackRate = totalScans > 0 ? this.metrics.topology_scanner.fallback_count / totalScans : 0;
        return {
            ...this.metrics,
            topology_scanner: {
                ...this.metrics.topology_scanner,
                avg_duration_ms: Number(avgDuration.toFixed(2)),
                success_rate: Number(successRate.toFixed(3)),
                fallback_rate: Number(fallbackRate.toFixed(3))
            }
        };
    }

    static exportToFile(filePath: string): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(this.getMetrics(), null, 2));
    }
}
