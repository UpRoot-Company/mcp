#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// -----------------------------------------------------------------------------
// 1. Tool Definitions & Schema
// -----------------------------------------------------------------------------

const ToolInputSchema = z.object({
  code: z.string().describe("The code snippet or file content to process"),
  instruction: z.string().optional().describe("Specific instructions for the task (e.g., 'Convert to TypeScript', 'Focus on performance')"),
});

const TOOLS: Tool[] = [
  {
    name: "polish_syntax",
    description: "Uses Codex Mini (Low Reasoning) for fast, mechanical fixes. Best for: Lint fixing, Type hinting, Formatting, Boilerplate generation.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code to polish" },
        instruction: { type: "string", description: "What to fix/polish (optional)" },
      },
      required: ["code"],
    },
  },
  {
    name: "scaffold_unit_test",
    description: "Uses Codex Standard (Medium Reasoning) to generate standard unit tests. Handles happy paths and edge cases.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Implementation code to test" },
        instruction: { type: "string", description: "Testing framework or specific scenarios (optional)" },
      },
      required: ["code"],
    },
  },
  {
    name: "generate_implementation",
    description: "Uses Codex Standard (Medium Reasoning) to implement logic from instructions. Best for: Function bodies, API handlers, Standard algorithms.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Context, signatures, or pseudo-code" },
        instruction: { type: "string", description: "What to implement" },
      },
      required: ["code", "instruction"],
    },
  },
  {
    name: "optimize_algorithm",
    description: "Uses Codex Max (High Reasoning) for complex problem solving. Best for: Performance optimization, Security hardening, Debugging race conditions.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Problematic or inefficient code" },
        instruction: { type: "string", description: "Optimization goal or bug description" },
      },
      required: ["code", "instruction"],
    },
  },
];

// -----------------------------------------------------------------------------
// 2. Codex Execution Logic
// -----------------------------------------------------------------------------

interface CodexConfig {
  model: "gpt-5.1-codex-mini" | "gpt-5.2" | "gpt-5.1-codex-max";
  reasoningEffort: "low" | "medium" | "high";
}

const TOOL_CONFIG_MAP: Record<string, CodexConfig> = {
  polish_syntax: { model: "gpt-5.1-codex-mini", reasoningEffort: "medium" },
  scaffold_unit_test: { model: "gpt-5.2", reasoningEffort: "low" },
  generate_implementation: { model: "gpt-5.2", reasoningEffort: "medium" },
  optimize_algorithm: { model: "gpt-5.1-codex-max", reasoningEffort: "high" },
}

async function execCodex(
  config: CodexConfig,
  code: string,
  instruction?: string
): Promise<string> {
  const { model, reasoningEffort } = config;

  // Construct the prompt
  const prompt = instruction
    ? `Instruction: ${instruction}\n\nCode:\n${code}`
    : `Code:\n${code}`;

  // Escape double quotes for shell safety
  const escapedPrompt = prompt.replace(/"/g, '\\"');

  // New command construction based on user's input
  const command = `codex --dangerously-bypass-approvals-and-sandbox --model ${model} --config model_reasoning_effort=${reasoningEffort} exec "${escapedPrompt}" --skip-git-repo-check`;

  try {
    // console.error(`[Codex-MCP] Executing: ${command.substring(0, 100)}...`); // Debug log to stderr
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 }); // 10MB buffer

    if (stderr) {
      console.error(`[Codex-CLI Stderr]: ${stderr}`);
    }

    return stdout.trim();
  } catch (error: any) {
    const errorMessage = error.stderr || error.message || "Unknown error";
    throw new Error(`Codex CLI execution failed: ${errorMessage}`);
  }
}

// -----------------------------------------------------------------------------
// 3. MCP Server Setup
// -----------------------------------------------------------------------------

const server = new Server(
  {
    name: "codex-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handler: List Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handler: Call Tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const config = TOOL_CONFIG_MAP[name];

  if (!config) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // Validate arguments
  const parsedArgs = ToolInputSchema.safeParse(args);
  if (!parsedArgs.success) {
    throw new Error(`Invalid arguments for ${name}: ${parsedArgs.error.message}`);
  }

  const { code, instruction } = parsedArgs.data;

  try {
    const result = await execCodex(config, code, instruction);
    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing Codex: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start Server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Codex MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
