import { EmbeddingProvider } from "../types.js";
import type { EmbeddingProviderClient } from "./EmbeddingProviderFactory.js";

export class DisabledEmbeddingProvider implements EmbeddingProviderClient {
    public readonly provider: EmbeddingProvider = "disabled";
    public readonly model = "";
    public readonly dims = 0;
    public readonly normalize = false;

    public async embed(_texts: string[]): Promise<Float32Array[]> {
        return [];
    }
}
