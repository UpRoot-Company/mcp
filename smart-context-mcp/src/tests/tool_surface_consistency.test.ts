import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { SmartContextServer } from "../index.js";

type ListedTool = {
    name: string;
    inputSchema?: {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
};

const readErrorCode = (response: any): string | undefined => {
    if (!response?.isError) return undefined;
    try {
        const parsed = JSON.parse(response.content?.[0]?.text ?? "{}");
        return parsed?.errorCode;
    } catch {
        return undefined;
    }
};

/**
 * Stronger tool surface consistency checks.
 *
 * We still avoid executing potentially expensive tools.
 * - Always: verify every listed tool name appears in the compiled switch-case.
 * - Additionally: validate `inputSchema.required` is consistent with `properties`.
 * - Additionally: for tools that declare required params, calling with `{}` should error quickly
 *   (i.e. not succeed, and not `UnknownTool`).
 */
describe("Tool surface consistency", () => {
    it("listed tools are handled and schemas are coherent", async () => {
        const server = new SmartContextServer(process.cwd());
        const tools = (server as any).listIntentTools() as ListedTool[];

        expect(Array.isArray(tools)).toBe(true);
        expect(tools.length).toBeGreaterThan(0);

        const distIndexPath = path.join(process.cwd(), "dist", "index.js");
        const compiled = fs.readFileSync(distIndexPath, "utf-8");

        const caseRegex = /case\s+\"([^\"]+)\"\s*:/g;
        const handled = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = caseRegex.exec(compiled)) !== null) {
            handled.add(match[1]);
        }

        const missingHandlers: string[] = [];
        for (const tool of tools) {
            if (!handled.has(tool.name)) {
                missingHandlers.push(tool.name);
            }
        }
        expect(missingHandlers).toEqual([]);

        for (const tool of tools) {
            const schema = tool.inputSchema;
            if (!schema) {
                continue;
            }

            const properties = schema.properties ?? {};
            const required = Array.isArray(schema.required) ? schema.required : [];

            for (const key of required) {
                expect(Object.prototype.hasOwnProperty.call(properties, key)).toBe(true);
            }

            // Only execute tools that declare required params; these should fail fast with empty args.
            if (required.length > 0) {
                const response = await (server as any).handleCallTool(tool.name, {});
                const errorCode = readErrorCode(response);

                expect(response?.isError).toBe(true);
                expect(errorCode).toBeDefined();
                expect(errorCode).not.toBe("UnknownTool");
            }
        }
    });
});
