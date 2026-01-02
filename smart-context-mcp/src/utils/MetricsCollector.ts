type MetricsMode = "off" | "basic" | "detailed";
type MetricsLevel = "basic" | "detailed";

type HistogramSnapshot = {
    count: number;
    min?: number;
    max?: number;
    mean?: number;
    p50?: number;
    p95?: number;
    p99?: number;
};

const DEFAULT_MODE = normalizeMode(process.env.SMART_CONTEXT_METRICS_MODE);
const DEFAULT_MAX_SAMPLES = normalizeMaxSamples(process.env.SMART_CONTEXT_METRICS_HIST_MAX_SAMPLES);

export class MetricsCollector {
    private readonly counters = new Map<string, number>();
    private readonly gauges = new Map<string, number>();
    private readonly histograms = new Map<string, Histogram>();
    private readonly mode: MetricsMode;
    private readonly maxSamples: number;

    constructor(options: { mode?: MetricsMode; maxSamples?: number } = {}) {
        this.mode = options.mode ?? DEFAULT_MODE;
        this.maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
    }

    public inc(name: string, by: number = 1, level: MetricsLevel = "basic"): void {
        if (!this.shouldRecord(level)) return;
        this.counters.set(name, (this.counters.get(name) ?? 0) + by);
    }

    public gauge(name: string, value: number, level: MetricsLevel = "basic"): void {
        if (!this.shouldRecord(level)) return;
        this.gauges.set(name, value);
    }

    public observe(name: string, value: number, level: MetricsLevel = "basic"): void {
        if (!this.shouldRecord(level)) return;
        if (!Number.isFinite(value)) return;
        this.getHistogram(name).observe(value);
    }

    public startTimer(name: string, level: MetricsLevel = "basic"): () => void {
        if (!this.shouldRecord(level)) {
            return () => {};
        }
        const start = nowMs();
        return () => this.observe(name, nowMs() - start, level);
    }

    public snapshot(): {
        counters: Record<string, number>;
        gauges: Record<string, number>;
        histograms: Record<string, HistogramSnapshot>;
    } {
        this.captureProcessMemory();
        const histograms: Record<string, HistogramSnapshot> = {};
        for (const [name, histogram] of this.histograms.entries()) {
            histograms[name] = histogram.snapshot();
        }
        return {
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
            histograms
        };
    }

    private shouldRecord(level: MetricsLevel): boolean {
        if (this.mode === "off") return false;
        if (this.mode === "basic" && level === "detailed") return false;
        return true;
    }

    private getHistogram(name: string): Histogram {
        const existing = this.histograms.get(name);
        if (existing) return existing;
        const created = new Histogram(this.maxSamples);
        this.histograms.set(name, created);
        return created;
    }

    private captureProcessMemory(): void {
        if (this.mode === "off") return;
        if (typeof process === "undefined" || typeof process.memoryUsage !== "function") return;
        const usage = process.memoryUsage();
        this.gauges.set("process.rss_bytes", usage.rss);
        this.gauges.set("process.heap_used_bytes", usage.heapUsed);
    }
}

class Histogram {
    private readonly maxSamples: number;
    private readonly values: number[] = [];
    private index = 0;
    private sum = 0;

    constructor(maxSamples: number) {
        this.maxSamples = Math.max(1, maxSamples);
    }

    public observe(value: number): void {
        if (this.values.length < this.maxSamples) {
            this.values.push(value);
            this.sum += value;
            return;
        }
        const replaced = this.values[this.index] ?? 0;
        this.values[this.index] = value;
        this.sum += value - replaced;
        this.index = (this.index + 1) % this.maxSamples;
    }

    public snapshot(): HistogramSnapshot {
        const count = this.values.length;
        if (count === 0) {
            return { count: 0 };
        }
        const sorted = [...this.values].sort((a, b) => a - b);
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const mean = this.sum / count;
        return {
            count,
            min,
            max,
            mean,
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
            p99: percentile(sorted, 0.99)
        };
    }
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
    return sorted[idx] ?? 0;
}

function normalizeMode(value: string | undefined): MetricsMode {
    const normalized = (value ?? "basic").trim().toLowerCase();
    if (normalized === "off" || normalized === "basic" || normalized === "detailed") {
        return normalized as MetricsMode;
    }
    return "basic";
}

function normalizeMaxSamples(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return 1024;
}

function nowMs(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
    }
    return Date.now();
}

export const metrics = new MetricsCollector();
