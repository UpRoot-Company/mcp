import { describe, it, expect } from "@jest/globals";
import { LegacyToolAdapter } from "../../orchestration/LegacyToolAdapter.js";

describe("LegacyToolAdapter", () => {
  const adapter = new LegacyToolAdapter();

  it("maps read_code to read pillar", () => {
    const result = adapter.adapt("read_code", { filePath: "src/demo.ts", view: "full" });
    expect(result).toEqual({
      category: "read",
      args: { target: "src/demo.ts", view: "full", lineRange: undefined }
    });
  });

  it("maps read_file and read_fragment to read pillar", () => {
    const readFile = adapter.adapt("read_file", { filePath: "src/demo.ts", full: false });
    expect(readFile).toEqual({
      category: "read",
      args: { target: "src/demo.ts", view: "skeleton", includeProfile: true }
    });

    const fragment = adapter.adapt("read_fragment", { filePath: "src/demo.ts", lineRange: "1-5" });
    expect(fragment).toEqual({
      category: "read",
      args: { target: "src/demo.ts", view: "fragment", lineRange: "1-5" }
    });
  });

  it("maps search_files to navigate pillar", () => {
    const result = adapter.adapt("search_files", { keywords: ["alpha", "beta"] });
    expect(result).toEqual({
      category: "navigate",
      args: { target: "alpha beta" }
    });
  });

  it("maps analyze_relationship to understand with include flags", () => {
    const result = adapter.adapt("analyze_relationship", { target: "src/demo.ts", mode: "calls", maxDepth: 4 });
    expect(result).toEqual({
      category: "understand",
      args: {
        goal: "Analyze calls of src/demo.ts",
        depth: "deep",
        include: { callGraph: true, dependencies: false }
      }
    });
  });

  it("maps edit_file to change pillar", () => {
    const result = adapter.adapt("edit_file", { filePath: "src/demo.ts", edits: [{ targetString: "a", replacementString: "b" }], dryRun: true });
    expect(result).toEqual({
      category: "change",
      args: {
        intent: "Apply specific edits",
        targetFiles: ["src/demo.ts"],
        edits: [{ targetString: "a", replacementString: "b" }],
        options: { dryRun: true }
      }
    });
  });

  it("maps write_file and get_batch_guidance", () => {
    const writeResult = adapter.adapt("write_file", { filePath: "src/new.ts", content: "const a = 1;" });
    expect(writeResult).toEqual({
      category: "write",
      args: { intent: "Write file content", targetPath: "src/new.ts", content: "const a = 1;" }
    });

    const batchResult = adapter.adapt("get_batch_guidance", { filePaths: ["a.ts", "b.ts"] });
    expect(batchResult).toEqual({
      category: "change",
      args: { intent: "Plan batch edits", targetFiles: ["a.ts", "b.ts"], options: { dryRun: true, batchMode: true } }
    });
  });

  it("maps manage_project to manage pillar", () => {
    const result = adapter.adapt("manage_project", { command: "history", target: "tx-1" });
    expect(result).toEqual({
      category: "manage",
      args: { command: "history", target: "tx-1" }
    });
  });
});
