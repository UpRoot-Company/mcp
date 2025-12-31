import { createRequire } from "module";
import { DocumentKind } from "../types.js";

export interface RemarkHeadingNode {
    title: string;
    level: number;
    line: number;
}

export interface RemarkLinkNode {
    text: string;
    href: string;
    line: number;
}

export interface RemarkParseResult {
    headings: RemarkHeadingNode[];
    links: RemarkLinkNode[];
}

export function parseMarkdownWithRemark(content: string, kind: DocumentKind): RemarkParseResult | null {
    try {
        const deps = loadRemarkDependencies();
        if (!deps) return null;

        const processor = deps.unified().use(deps.remarkParse);
        if (kind === "mdx") {
            processor.use(deps.remarkMdx);
        }

        const tree = processor.parse(content);
        const headings: RemarkHeadingNode[] = [];
        const links: RemarkLinkNode[] = [];
        const definitions = new Map<string, string>();

        deps.visit(tree as any, "heading", (node: any) => {
            const title = (deps.toString(node) || "").trim();
            if (!title) return;
            headings.push({
                title,
                level: node.depth ?? 1,
                line: node.position?.start?.line ?? 1
            });
        });

        deps.visit(tree as any, "definition", (node: any) => {
            const identifier = normalizeReference(node.identifier ?? node.label ?? "");
            const url = String(node.url ?? "").trim();
            if (!identifier || !url) return;
            definitions.set(identifier, url);
        });

        deps.visit(tree as any, "link", (node: any) => {
            const href = String(node.url ?? "");
            if (!href) return;
            const text = (deps.toString(node) || "").trim();
            links.push({
                text,
                href,
                line: node.position?.start?.line ?? 1
            });
        });

        deps.visit(tree as any, "linkReference", (node: any) => {
            const identifier = normalizeReference(node.identifier ?? node.label ?? "");
            if (!identifier) return;
            const href = definitions.get(identifier);
            if (!href) return;
            const text = (deps.toString(node) || "").trim();
            links.push({
                text,
                href,
                line: node.position?.start?.line ?? 1
            });
        });

        return { headings, links };
    } catch {
        return null;
    }
}

const requireFn = createRequire(import.meta.url);

function loadRemarkDependencies(): {
    unified: any;
    remarkParse: any;
    remarkMdx: any;
    visit: any;
    toString: any;
} | null {
    try {
        const unifiedModule = requireFn("unified");
        const unified = unifiedModule.unified ?? unifiedModule;
        const remarkParse = unwrapDefault(requireFn("remark-parse"));
        const remarkMdx = unwrapDefault(requireFn("remark-mdx"));
        const visitModule = requireFn("unist-util-visit");
        const visit = visitModule.visit ?? visitModule;
        const toStringModule = requireFn("mdast-util-to-string");
        const toString = toStringModule.toString ?? toStringModule;
        if (!unified || !remarkParse || !remarkMdx || !visit || !toString) {
            return null;
        }
        return { unified, remarkParse, remarkMdx, visit, toString };
    } catch {
        return null;
    }
}

function unwrapDefault(moduleValue: any): any {
    if (!moduleValue) return moduleValue;
    return moduleValue.default ?? moduleValue;
}

function normalizeReference(value: string): string {
    return String(value || "").trim().toLowerCase();
}
