const PREFIX_QUERY = "query: ";
const PREFIX_PASSAGE = "passage: ";

export function applyEmbeddingPrefix(texts: string[], mode: "query" | "passage", model: string): string[] {
    if (!shouldApplyPrefix(model)) return texts;
    const prefix = mode === "query" ? PREFIX_QUERY : PREFIX_PASSAGE;
    return texts.map((text) => addPrefix(text, prefix));
}

function shouldApplyPrefix(model: string): boolean {
    const enabled = (process.env.SMART_CONTEXT_EMBEDDING_E5_PREFIX ?? "true").trim().toLowerCase() !== "false";
    if (!enabled) return false;
    const normalized = (model ?? "").trim().toLowerCase();
    return normalized.includes("e5");
}

function addPrefix(text: string, prefix: string): string {
    const normalized = text.trimStart().toLowerCase();
    if (normalized.startsWith(PREFIX_QUERY) || normalized.startsWith(PREFIX_PASSAGE)) {
        return text;
    }
    return `${prefix}${text}`;
}
