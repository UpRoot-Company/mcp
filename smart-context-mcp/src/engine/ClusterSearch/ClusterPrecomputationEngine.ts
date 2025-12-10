import { HotSpotDetector, HotSpot } from "./HotSpotDetector.js";
import type { ClusterSearchOptions } from "./index.js";

export interface ClusterPrecomputationConfig {
    intervalMs?: number;
    maxQueriesPerCycle?: number;
    batchSize?: number;
    precomputeOptions?: ClusterSearchOptions;
}

const DEFAULT_PRECOMPUTE_CONFIG: Required<ClusterPrecomputationConfig> = {
    intervalMs: 5 * 60 * 1000,
    maxQueriesPerCycle: 10,
    batchSize: 3,
    precomputeOptions: {
        maxClusters: 3,
        expandRelationships: { all: true },
        expansionDepth: 2,
        includePreview: true
    }
};

type SearchExecutor = (query: string, options: ClusterSearchOptions) => Promise<unknown>;

type Logger = (message: string, ...args: unknown[]) => void;

export class ClusterPrecomputationEngine {
    private timer?: NodeJS.Timeout;
    private running = false;
    private cycleInFlight = false;
    private config: Required<ClusterPrecomputationConfig>;

    constructor(
        private readonly hotSpotDetector: HotSpotDetector,
        private readonly executeSearch: SearchExecutor,
        config: ClusterPrecomputationConfig = {},
        private readonly logger: Logger = () => {}
    ) {
        this.config = {
            intervalMs: config.intervalMs ?? DEFAULT_PRECOMPUTE_CONFIG.intervalMs,
            maxQueriesPerCycle: config.maxQueriesPerCycle ?? DEFAULT_PRECOMPUTE_CONFIG.maxQueriesPerCycle,
            batchSize: config.batchSize ?? DEFAULT_PRECOMPUTE_CONFIG.batchSize,
            precomputeOptions: {
                ...DEFAULT_PRECOMPUTE_CONFIG.precomputeOptions,
                ...config.precomputeOptions
            }
        };
    }

    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.scheduleNext(0);
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    requestImmediateRun(): void {
        if (!this.running) {
            return;
        }
        this.scheduleNext(250);
    }

    private scheduleNext(delay = this.config.intervalMs): void {
        if (!this.running) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.runCycle().catch(error => {
                this.logger("[ClusterPrecompute] cycle failed", error);
            });
        }, delay);
    }

    private async runCycle(): Promise<void> {
        if (!this.running || this.cycleInFlight) {
            return;
        }
        this.cycleInFlight = true;
        try {
            const hotSpots = await this.hotSpotDetector.detectHotSpots();
            if (hotSpots.length === 0) {
                return;
            }
            const targets = hotSpots.slice(0, this.config.maxQueriesPerCycle);
            for (let index = 0; index < targets.length; index += this.config.batchSize) {
                const batch = targets.slice(index, index + this.config.batchSize);
                await Promise.all(batch.map(hotSpot => this.precomputeHotSpot(hotSpot)));
            }
        } catch (error) {
            this.logger("[ClusterPrecompute] unexpected error", error);
        } finally {
            this.cycleInFlight = false;
            this.scheduleNext();
        }
    }

    private async precomputeHotSpot(hotSpot: HotSpot): Promise<void> {
        try {
            await this.executeSearch(hotSpot.symbol.name, this.config.precomputeOptions);
        } catch (error) {
            this.logger(`[ClusterPrecompute] failed for ${hotSpot.symbol.name}`, error);
        }
    }
}
