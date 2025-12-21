import { ParsedIntent } from "./IntentRouter.js";
import { OrchestrationContext } from "./OrchestrationContext.js";
import { InternalToolRegistry } from "./InternalToolRegistry.js";

export class EagerLoadingStrategy {
  public async execute(
    intent: ParsedIntent,
    context: OrchestrationContext,
    registry: InternalToolRegistry
  ): Promise<void> {
    if (intent.category === "understand") {
      await this.ensureHotSpots(context, registry);
      const hotSpotCount = this.getHotSpotCount(context);
      const deep = intent.constraints.depth === "deep";
      const forceDeps = intent.constraints.include?.dependencies === true;
      const forceCalls = intent.constraints.include?.callGraph === true;
      const eager = deep || hotSpotCount >= 5;

      if (eager || forceDeps) {
        await this.ensureRelationships(context, registry);
      }
      if (eager || forceCalls) {
        await this.ensureCallGraph(intent, context, registry);
      }
      return;
    }

    if (intent.category === "navigate") {
      await this.ensureProfile(context, registry);
    }
  }

  private async ensureCallGraph(
    intent: ParsedIntent,
    context: OrchestrationContext,
    registry: InternalToolRegistry
  ): Promise<void> {
    const already = context.getFullHistory().some(step => step.tool === "analyze_relationship" && step.args?.mode === "calls");
    if (already) return;
    if (intent.constraints.include?.callGraph === false) return;

    const target = this.extractTarget(context);
    if (!target) return;

    const maxDepth = intent.constraints.depth === "deep" ? 3 : 1;
    const started = Date.now();
    try {
      const output = await registry.execute("analyze_relationship", {
        target,
        mode: "calls",
        direction: "both",
        maxDepth
      });
      context.addStep({
        id: "eager_calls",
        tool: "analyze_relationship",
        args: { target, mode: "calls", direction: "both", maxDepth },
        output,
        status: "success",
        duration: Date.now() - started
      });
    } catch (error: any) {
      context.addError({
        code: error?.code ?? "EAGER_LOAD_FAILED",
        message: error?.message ?? "Eager loading failed.",
        tool: "analyze_relationship",
        target
      });
    }
  }

  private async ensureRelationships(
    context: OrchestrationContext,
    registry: InternalToolRegistry
  ): Promise<void> {
    const already = context.getFullHistory().some(step => step.tool === "analyze_relationship");
    if (already) return;

    const target = this.extractTarget(context);
    if (!target) return;

    const started = Date.now();
    try {
      const output = await registry.execute("analyze_relationship", {
        target,
        mode: "dependencies",
        direction: "both"
      });
      context.addStep({
        id: "eager_dependencies",
        tool: "analyze_relationship",
        args: { target, mode: "dependencies", direction: "both" },
        output,
        status: "success",
        duration: Date.now() - started
      });
    } catch (error: any) {
      context.addError({
        code: error?.code ?? "EAGER_LOAD_FAILED",
        message: error?.message ?? "Eager loading failed.",
        tool: "analyze_relationship",
        target
      });
    }
  }

  private async ensureHotSpots(
    context: OrchestrationContext,
    registry: InternalToolRegistry
  ): Promise<void> {
    const already = context.getFullHistory().some(step => step.tool === "hotspot_detector");
    if (already) return;

    const started = Date.now();
    try {
      const output = await registry.execute("hotspot_detector", {});
      context.addStep({
        id: "eager_hotspots",
        tool: "hotspot_detector",
        args: {},
        output,
        status: "success",
        duration: Date.now() - started
      });
    } catch (error: any) {
      context.addError({
        code: error?.code ?? "EAGER_LOAD_FAILED",
        message: error?.message ?? "Eager loading failed.",
        tool: "hotspot_detector"
      });
    }
  }

  private getHotSpotCount(context: OrchestrationContext): number {
    const step = context.getFullHistory().slice().reverse().find(s => s.tool === "hotspot_detector");
    if (!step || !Array.isArray(step.output)) return 0;
    return step.output.length;
  }

  private async ensureProfile(
    context: OrchestrationContext,
    registry: InternalToolRegistry
  ): Promise<void> {
    const already = context.getFullHistory().some(step => step.tool === "file_profiler");
    if (already) return;

    const target = this.extractTarget(context);
    if (!target) return;

    const started = Date.now();
    try {
      const output = await registry.execute("file_profiler", { filePath: target });
      context.addStep({
        id: "eager_profile",
        tool: "file_profiler",
        args: { filePath: target },
        output,
        status: "success",
        duration: Date.now() - started
      });
    } catch (error: any) {
      context.addError({
        code: error?.code ?? "EAGER_LOAD_FAILED",
        message: error?.message ?? "Eager loading failed.",
        tool: "file_profiler",
        target
      });
    }
  }

  private extractTarget(context: OrchestrationContext): string | null {
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
}
