import { describe, it, expect } from "@jest/globals";
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
 * - Additionally: validate `inputSchema.required` is consistent with `properties`.
 * - Additionally: for tools that declare required params, calling with `{}` should error quickly
 *   (i.e. not succeed, and not `UnknownTool`).
 */
describe("Tool surface consistency", () => {
    it("Intent tools are stable, handled, and schemas are coherent", async () => {
        const server = new SmartContextServer(process.cwd());
        const tools = (server as any).listIntentTools() as ListedTool[];

        const expectedIntentTools = [
            "understand",
            "change",
            "navigate",
            "read",
            "write",
            "manage",
        ].sort();

        expect(Array.isArray(tools)).toBe(true);
        expect(tools.map((t) => t.name).sort()).toEqual(expectedIntentTools);


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
                expect(errorCode).toBe("MissingParameter");
            }

        }
        await server.shutdown();
        });

    it("Legacy tools are exposed only when enabled", async () => {
        const prevLegacy = process.env.SMART_CONTEXT_EXPOSE_LEGACY_TOOLS;
        const prev = process.env.SMART_CONTEXT_EXPOSE_COMPAT_TOOLS;
        process.env.SMART_CONTEXT_EXPOSE_LEGACY_TOOLS = "true";
        process.env.SMART_CONTEXT_EXPOSE_COMPAT_TOOLS = "true";

        try {
            const server = new SmartContextServer(process.cwd());
            const tools = (server as any).listIntentTools() as ListedTool[];
            const names = tools.map((t) => t.name);

            expect(names).toEqual(expect.arrayContaining([
                "read_code",
                "search_project",
                "analyze_relationship",
                "edit_code",
                "get_batch_guidance",
                "manage_project",
                "reconstruct_interface",
                "understand",
                "change",
                "navigate",
                "read",
                "write",
                "manage",
                "read_file",
                "write_file",
                "analyze_file",
            ]));
            expect(names.length).toBeGreaterThan(5);
            await server.shutdown();
        } finally {
            if (prev === undefined) {
                delete process.env.SMART_CONTEXT_EXPOSE_COMPAT_TOOLS;
            } else {
                process.env.SMART_CONTEXT_EXPOSE_COMPAT_TOOLS = prev;
            }
            if (prevLegacy === undefined) {
                delete process.env.SMART_CONTEXT_EXPOSE_LEGACY_TOOLS;
            } else {
                process.env.SMART_CONTEXT_EXPOSE_LEGACY_TOOLS = prevLegacy;
            }
        }
    });
});
