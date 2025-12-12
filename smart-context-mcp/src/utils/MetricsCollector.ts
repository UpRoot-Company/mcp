export class MetricsCollector {
    private readonly counters = new Map<string, number>();
    private readonly gauges = new Map<string, number>();

    public inc(name: string, by: number = 1): void {
        this.counters.set(name, (this.counters.get(name) ?? 0) + by);
    }

    public gauge(name: string, value: number): void {
        this.gauges.set(name, value);
    }

    public snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
        return {
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges)
        };
    }
}

export const metrics = new MetricsCollector();

