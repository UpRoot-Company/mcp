import path from 'path';

export class FilenameScorer {
    public scoreFilename(
        filePath: string, 
        keywords: string[], 
        options?: { wordBoundary?: boolean }
    ): "exact" | "partial" | "none" {
        const baseName = path.basename(filePath).toLowerCase();
        const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
        const requireExact = options?.wordBoundary === true;
        let matchType: "exact" | "partial" | "none" = "none";

        for (const keyword of keywords) {
            const normalized = keyword.toLowerCase().trim();
            if (!normalized) {
                continue;
            }
            if (baseName === normalized || stem === normalized) {
                return "exact";
            }
            if (!requireExact && (baseName.includes(normalized) || stem.includes(normalized))) {
                matchType = "partial";
            }
        }

        return matchType;
    }

    public calculateFilenameScore(
        filepath: string,
        query: string,
        options: { fuzzy: boolean; basenameOnly: boolean }
    ): number {
        const target = options.basenameOnly
            ? path.basename(filepath)
            : filepath;

        const lowerTarget = target.toLowerCase();
        const lowerQuery = query.toLowerCase();

        // Exact match: highest score
        if (lowerTarget === lowerQuery) return 100;

        // Basename exact match
        if (path.basename(filepath).toLowerCase() === lowerQuery) return 90;

        // Starts with query
        if (lowerTarget.startsWith(lowerQuery)) return 80;

        // Contains query
        if (lowerTarget.includes(lowerQuery)) return 60;

        // Fuzzy matching (if enabled)
        if (options.fuzzy) {
            const distance = this.levenshteinDistance(lowerQuery, path.basename(filepath).toLowerCase());
            const maxLength = Math.max(lowerQuery.length, path.basename(filepath).length);
            const similarity = 1 - (distance / maxLength);

            if (similarity > 0.7) return similarity * 50;
        }

        return 0;
    }

    private levenshteinDistance(a: string, b: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        matrix[i][j - 1] + 1,     // insertion
                        matrix[i - 1][j] + 1      // deletion
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }
}
