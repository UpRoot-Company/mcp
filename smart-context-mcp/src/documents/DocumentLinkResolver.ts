import * as path from "path";

export interface ResolvedLink {
    text?: string;
    href: string;
    resolvedPath?: string;
    hashFragment?: string;
}

export class DocumentLinkResolver {
    constructor(private readonly rootPath: string) {}

    public resolveLink(filePath: string, href: string, text?: string): ResolvedLink {
        if (!href || typeof href !== "string") {
            return { text, href: href ?? "" };
        }

        const trimmed = href.trim();
        if (!trimmed) return { text, href: trimmed };

        if (this.isExternalLink(trimmed)) {
            return { text, href: trimmed };
        }

        const [pathPart, hashFragment] = splitHash(trimmed);
        if (!pathPart && hashFragment) {
            return {
                text,
                href: trimmed,
                resolvedPath: normalizePath(filePath),
                hashFragment
            };
        }

        const baseDir = path.dirname(filePath);
        const resolved = pathPart.startsWith("/")
            ? path.resolve(this.rootPath, pathPart.slice(1))
            : path.resolve(this.rootPath, baseDir, pathPart);

        return {
            text,
            href: trimmed,
            resolvedPath: normalizePath(path.relative(this.rootPath, resolved)),
            hashFragment
        };
    }

    private isExternalLink(href: string): boolean {
        return /^(https?:|mailto:|tel:|file:)/i.test(href);
    }
}

function splitHash(href: string): [string, string | undefined] {
    const idx = href.indexOf("#");
    if (idx === -1) return [href, undefined];
    return [href.slice(0, idx), href.slice(idx + 1) || undefined];
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, "/");
}
