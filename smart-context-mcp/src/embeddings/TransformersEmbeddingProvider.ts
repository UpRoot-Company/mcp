import type { EmbeddingProvider } from "../types.js";
import type { EmbeddingProviderClient } from "./EmbeddingProviderFactory.js";

type TransformersPipeline = (inputs: string[] | string, options?: Record<string, unknown>) => Promise<any>;

export class TransformersEmbeddingProvider implements EmbeddingProviderClient {
    public readonly provider: EmbeddingProvider = "local";
    public readonly model: string;
    public dims: number;
    public readonly normalize: boolean;

    private pipelinePromise?: Promise<TransformersPipeline>;

    constructor(options: { model: string; dims?: number; normalize: boolean }) {
        this.model = options.model;
        this.dims = options.dims ?? 0;
        this.normalize = options.normalize;
    }

    public async embed(texts: string[]): Promise<Float32Array[]> {
        const pipeline = await this.getPipeline();
        const output = await pipeline(texts, {
            pooling: "mean",
            normalize: this.normalize,
            quantized: true
        });

        const vectors = tensorToVectors(output, texts.length);
        if (vectors.length > 0 && this.dims === 0) {
            this.dims = vectors[0].length;
        }
        return vectors;
    }

    private async getPipeline(): Promise<TransformersPipeline> {
        if (!this.pipelinePromise) {
            this.pipelinePromise = this.loadPipeline();
        }
        return this.pipelinePromise;
    }

    private async loadPipeline(): Promise<TransformersPipeline> {
        const module: any = await import("@xenova/transformers");
        const pipeline = module.pipeline ?? module.default?.pipeline;
        if (!pipeline) {
            throw new Error("Failed to load transformers pipeline");
        }
        return pipeline("feature-extraction", this.model);
    }
}

function tensorToVectors(output: any, expectedCount: number): Float32Array[] {
    if (output?.data && Array.isArray(output.dims)) {
        const dims = output.dims as number[];
        if (dims.length >= 2) {
            const [batch, width] = dims;
            const data = toFloat32Array(output.data);
            const count = Math.min(batch, expectedCount);
            const vectors: Float32Array[] = [];
            for (let i = 0; i < count; i += 1) {
                const offset = i * width;
                const slice = data.subarray(offset, offset + width);
                const vector = new Float32Array(width);
                vector.set(slice);
                vectors.push(vector);
            }
            return vectors;
        }
        if (dims.length === 1) {
            const width = dims[0];
            const data = toFloat32Array(output.data);
            const vector = new Float32Array(width);
            vector.set(data.subarray(0, width));
            return [vector];
        }
    }

    if (typeof output?.tolist === "function") {
        const list = output.tolist();
        if (Array.isArray(list)) {
            return list.map((row: number[] | Float32Array) => {
                const vec = new Float32Array(row.length);
                vec.set(Array.from(row));
                return vec;
            });
        }
    }

    if (Array.isArray(output)) {
        return output.map((row: number[] | Float32Array) => {
            const vec = new Float32Array(row.length);
            vec.set(Array.from(row));
            return vec;
        });
    }

    throw new Error("Unexpected transformers embedding output");
}

function toFloat32Array(data: any): Float32Array {
    if (data instanceof Float32Array) return data;
    if (ArrayBuffer.isView(data)) {
        return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    }
    if (Array.isArray(data)) {
        return Float32Array.from(data);
    }
    return new Float32Array(0);
}
