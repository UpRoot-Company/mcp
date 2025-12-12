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

// NOTE: Adjust this command to match your actual CLI wrapper for Claude
const CLI_COMMAND = "copilot"; 

// -----------------------------------------------------------------------------
// 1. Tool Definitions
// -----------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "draft_commit_message",
    description: "Uses Claude 4.5 Haiku. Fast & Concise. Generates git commit messages or PR titles from diffs.",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string", description: "Git diff content or summary of changes" },
        context: { type: "string", description: "Additional context (e.g. ticket number, type of change)" },
      },
      required: ["diff"],
    },
  },
  {
    name: "craft_documentation",
    description: "Uses Claude 4.5 Sonnet. Best for writing technical docs. Generates READMEs, JSDocs, or explanations.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code to document" },
        format: { type: "string", description: "Output format (e.g., 'markdown', 'jsdoc', 'comments')" },
        audience: { type: "string", description: "Target audience (e.g., 'user', 'developer', 'api-consumer')" },
      },
      required: ["code"],
    },
  },
  {
    name: "expert_code_review",
    description: "Uses Claude 4.5 Sonnet. Acts as a Senior Developer. Reviews code for maintainability, style, and logic.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code to review" },
        focus: { type: "string", description: "Specific focus area (e.g., 'security', 'performance', 'readability')" },
      },
      required: ["code"],
    },
  },
  {
    name: "architectural_decision",
    description: "Uses Claude 4.5 Opus. Deepest reasoning. Drafts ADRs, migration strategies, or high-level system designs.",
    inputSchema: {
      type: "object",
      properties: {
        problem: { type: "string", description: "The architectural problem or requirement" },
        constraints: { type: "string", description: "System constraints, legacy limitations, or business goals" },
        current_stack: { type: "string", description: "Current technology stack overview" },
      },
      required: ["problem"],
    },
  },
];

// -----------------------------------------------------------------------------
// 2. Claude Execution Logic
// -----------------------------------------------------------------------------

type ClaudeModel = "claude-haiku-4.5" | "claude-sonnet-4.5" | "claude-opus-4.5";

const TOOL_MODEL_MAP: Record<string, ClaudeModel> = {
  draft_commit_message: "claude-haiku-4.5",
  craft_documentation: "claude-sonnet-4.5",
  expert_code_review: "claude-sonnet-4.5",
  architectural_decision: "claude-opus-4.5",
};

async function execClaude(
  model: ClaudeModel,
  prompt: string
): Promise<string> {
  // Construct command
  const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  const command = `${CLI_COMMAND} --model ${model} -p "${escapedPrompt}" --allow-all-tools`; // Added -p and --allow-all-tools

  console.error(`[Claude-MCP] Debugging command: ${command}`); // Log the command

  try {
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });

    if (stderr) {
      console.error(`[Claude-CLI Stderr]: ${stderr}`);
    }
    return stdout.trim();
  } catch (error: any) {
    const errorMessage = error.stderr || error.message || "Unknown error";
    throw new Error(`Claude CLI execution failed: ${errorMessage}`);
  }
}

// -----------------------------------------------------------------------------
// 3. MCP Server Setup
// -----------------------------------------------------------------------------

const server = new Server(
  {
    name: "claude-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const model = TOOL_MODEL_MAP[name];

  if (!model) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // Construct prompt based on tool
  let prompt = "";
  // Safe casting since we validated schema in a real app, simplified here
  const safeArgs = args as any; 

  switch (name) {
    case "draft_commit_message":
      prompt = `Role: Git Commit Assistant. Task: Write a concise and descriptive commit message based on the following diff. Context: ${safeArgs.context || "None"}. Diff:\n${safeArgs.diff}`;
      break;
    case "craft_documentation":
      prompt = `Role: Technical Writer. Task: Write documentation for the following code. Format: ${safeArgs.format || "Markdown"}. Audience: ${safeArgs.audience || "Developers"}. Code:\n${safeArgs.code}`;
      break;
    case "expert_code_review":
      prompt = `Role: Senior Software Engineer. Task: Review the following code. Be constructive, strict but helpful. Focus on: ${safeArgs.focus || "General Best Practices"}. Code:\n${safeArgs.code}`;
      break;
    case "architectural_decision":
      prompt = `Role: Software Architect. Task: Provide a high-level solution or ADR (Architecture Decision Record). Problem: ${safeArgs.problem}. Constraints: ${safeArgs.constraints || "None"}. Current Stack: ${safeArgs.current_stack || "Not specified"}.`;
      break;
  }

  try {
    const result = await execClaude(model, prompt);
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
          text: `Error executing Claude: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
