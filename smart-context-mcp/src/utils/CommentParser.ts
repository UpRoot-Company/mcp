import path from 'path';

export class CommentParser {
    public isCommentLine(line: string): boolean {
        const trimmed = line.trim();
        return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
    }

    public extractComments(content: string, filePath: string): string[] {
        const comments: string[] = [];
        const ext = path.extname(filePath);

        if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            const singleLineRegex = /\/\/(.+)$/gm;
            let match;
            while ((match = singleLineRegex.exec(content)) !== null) {
                comments.push(match[1].trim());
            }

            const multiLineRegex = /\/\*([\s\S]*?)\*\//g;
            while ((match = multiLineRegex.exec(content)) !== null) {
                comments.push(match[1].trim());
            }
        }

        return comments;
    }
}
