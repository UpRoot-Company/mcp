import { ParsedIntent } from "./IntentRouter.js";
import { OrchestrationContext } from "./OrchestrationContext.js";
import { InternalToolRegistry } from "./InternalToolRegistry.js";

export class AutoCorrectionStrategy {
  public async attempt(
    intent: ParsedIntent,
    context: OrchestrationContext,
    registry: InternalToolRegistry
  ): Promise<boolean> {
    if (intent.category !== "change") return false;
    const edits = Array.isArray(intent.constraints.edits) ? intent.constraints.edits : [];
    if (edits.length === 0) return false;

    const lastError = context.getErrors().slice(-1)[0];
    if (!lastError) return false;
    const code = lastError.code ?? "";
    if (!this.isMatchFailure(code, lastError.message)) return false;

    const filePath = this.findTargetPath(context, edits);
    if (!filePath) return false;

    const attempts = [
      { label: "whitespace", edits: this.applyWhitespace(edits, filePath) },
      { label: "structural", edits: this.applyStructural(edits, filePath) },
      { label: "fuzzy", edits: this.applyFuzzy(edits, filePath) }
    ];

    for (const attempt of attempts) {
      const started = Date.now();
      try {
        const output = await registry.execute("edit_coordinator", {
          filePath,
          edits: attempt.edits,
          dryRun: true
        });
        context.addStep({
          id: `auto_correct_${attempt.label}`,
          tool: "edit_coordinator",
          args: { filePath, edits: attempt.edits, dryRun: true },
          output,
          status: output?.success ? "success" : "failure",
          duration: Date.now() - started
        });
        if (output?.success) {
          return true;
        }
      } catch (error: any) {
        context.addError({
          code: error?.code ?? "AUTO_CORRECT_FAILED",
          message: error?.message ?? "Auto-correction failed.",
          tool: "edit_coordinator",
          target: filePath
        });
        return false;
      }
    }

    return false;
  }

  private isMatchFailure(code: string, message: string): boolean {
    if (code === "NO_MATCH" || code === "AMBIGUOUS_MATCH" || code === "HASH_MISMATCH") {
      return true;
    }
    return /no match|ambiguous|hash mismatch/i.test(message);
  }

  private findTargetPath(context: OrchestrationContext, edits: any[]): string | null {
    const fromEdits = edits.find((edit: any) => typeof edit.filePath === "string")?.filePath;
    if (fromEdits) return fromEdits;

    const history = context.getFullHistory();
    for (let i = history.length - 1; i >= 0; i--) {
      const output = history[i]?.output;
      if (!output) continue;
      if (typeof output.filePath === "string") return output.filePath;
      if (typeof output.path === "string") return output.path;
      if (output?.results?.[0]?.path) return output.results[0].path;
    }
    return null;
  }

  private applyWhitespace(edits: any[], filePath: string): any[] {
    return edits.map((edit: any) => ({
      ...edit,
      filePath: edit.filePath || filePath,
      fuzzyMode: edit.fuzzyMode ?? "whitespace"
    }));
  }

  private applyStructural(edits: any[], filePath: string): any[] {
    return edits.map((edit: any) => ({
      ...edit,
      filePath: edit.filePath || filePath,
      normalization: edit.normalization ?? "structural"
    }));
  }

  private applyFuzzy(edits: any[], filePath: string): any[] {
    return edits.map((edit: any) => ({
      ...edit,
      filePath: edit.filePath || filePath,
      fuzzyMode: edit.fuzzyMode ?? "levenshtein"
    }));
  }
}
