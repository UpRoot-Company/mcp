
export type QueryIntent = 'symbol' | 'file' | 'code' | 'bug';

export class QueryIntentDetector {
    detect(query: string): QueryIntent {
        const lower = query.toLowerCase();

        if (lower.includes('class') || lower.includes('interface') ||
            lower.includes('function') || lower.includes('const') || 
            lower.includes('enum') || lower.includes('type')) {
            return 'symbol';
        }

        if (lower.includes('file') || lower.includes('config') ||
            lower.includes('json') || lower.includes('yaml') || 
            lower.includes('xml') || lower.includes('md')) {
            return 'file';
        }

        if (lower.includes('error') || lower.includes('bug') ||
            lower.includes('check') || lower.includes('fix') || 
            lower.includes('issue') || lower.includes('fail')) {
            return 'bug';
        }

        return 'code';
    }
}
