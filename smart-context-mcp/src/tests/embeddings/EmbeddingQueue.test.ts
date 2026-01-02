import { describe, it, expect } from "@jest/globals";
import { EmbeddingQueue, EmbeddingTimeoutError } from "../../embeddings/EmbeddingQueue.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("EmbeddingQueue", () => {
    it("enforces concurrency=1 (serial execution)", async () => {
        const queue = new EmbeddingQueue({ concurrency: 1, defaultTimeoutMs: 5_000 });
        let active = 0;
        let maxActive = 0;

        const task = async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(30);
            active -= 1;
            return true;
        };

        await Promise.all([
            queue.run(task),
            queue.run(task),
            queue.run(task)
        ]);

        expect(maxActive).toBe(1);
    });

    it("enforces concurrency>1", async () => {
        const queue = new EmbeddingQueue({ concurrency: 2, defaultTimeoutMs: 5_000 });
        let active = 0;
        let maxActive = 0;

        const task = async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(50);
            active -= 1;
            return true;
        };

        await Promise.all([
            queue.run(task),
            queue.run(task),
            queue.run(task),
            queue.run(task)
        ]);

        expect(maxActive).toBeGreaterThanOrEqual(2);
    });

    it("times out tasks", async () => {
        const queue = new EmbeddingQueue({ concurrency: 1, defaultTimeoutMs: 10 });
        await expect(queue.run(async () => {
            await sleep(50);
            return "ok";
        })).rejects.toBeInstanceOf(EmbeddingTimeoutError);
    });
});

