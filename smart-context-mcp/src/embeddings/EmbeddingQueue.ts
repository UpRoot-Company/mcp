import { metrics } from "../utils/MetricsCollector.js";

export class EmbeddingTimeoutError extends Error {
    public readonly name = "EmbeddingTimeoutError";
    constructor(message: string, public readonly timeoutMs: number) {
        super(message);
    }
}

type QueueTask<T> = {
    run: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    timeoutMs?: number;
    label?: string;
};

export class EmbeddingQueue {
    private readonly queue: Array<QueueTask<any>> = [];
    private active = 0;

    constructor(private readonly options: { concurrency: number; defaultTimeoutMs?: number; maxQueueSize?: number }) {}

    public get size(): number {
        return this.queue.length;
    }

    public async run<T>(task: () => Promise<T>, opts?: { timeoutMs?: number; label?: string }): Promise<T> {
        const maxQueueSize = this.options.maxQueueSize ?? 0;
        if (maxQueueSize > 0 && this.queue.length >= maxQueueSize) {
            throw new Error(`Embedding queue full (maxQueueSize=${maxQueueSize})`);
        }

        return new Promise<T>((resolve, reject) => {
            this.queue.push({
                run: task,
                resolve,
                reject,
                timeoutMs: opts?.timeoutMs,
                label: opts?.label
            });
            this.updateQueueGauge();
            this.pump();
        });
    }

    private pump(): void {
        const concurrency = Math.max(1, this.options.concurrency);
        while (this.active < concurrency && this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next) return;
            this.active += 1;
            this.updateQueueGauge();
            void this.execute(next).finally(() => {
                this.active -= 1;
                this.pump();
            });
        }
    }

    private async execute<T>(task: QueueTask<T>): Promise<void> {
        const timeoutMs = task.timeoutMs ?? this.options.defaultTimeoutMs ?? 0;
        if (timeoutMs > 0) {
            let timer: NodeJS.Timeout | undefined;
            try {
                const result = await Promise.race([
                    task.run(),
                    new Promise<T>((_, reject) => {
                        timer = setTimeout(() => {
                            reject(new EmbeddingTimeoutError(`Embedding timed out after ${timeoutMs}ms`, timeoutMs));
                        }, timeoutMs);
                    })
                ]);
                task.resolve(result);
            } catch (err) {
                if (err instanceof EmbeddingTimeoutError) {
                    metrics.inc("embeddings.queue_timeouts_total");
                }
                task.reject(err);
            } finally {
                if (timer) clearTimeout(timer);
            }
            return;
        }

        try {
            const result = await task.run();
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        }
    }

    private updateQueueGauge(): void {
        metrics.gauge("embeddings.queue_depth", this.queue.length);
    }
}

