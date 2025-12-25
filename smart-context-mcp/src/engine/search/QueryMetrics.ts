export interface QueryMetrics {
  raw: string;
  length: number;
  tokenCount: number;
  hasPath: boolean;
  hasSymbolHint: boolean;
  strong: boolean;
}

const tokenize = (value: string): string[] =>
  value.trim().split(/\s+/).filter(Boolean);

export const analyzeQuery = (query: string): QueryMetrics => {
  const raw = String(query ?? '');
  const tokens = tokenize(raw);
  const length = raw.length;
  const hasPath = /[\\/]/.test(raw) || /\.[a-z0-9]+$/i.test(raw);
  const hasSymbolHint = /\b[A-Za-z_$][\w$]*\b/.test(raw) && /[A-Z_]/.test(raw);
  const strong = hasPath || tokens.length >= 2 || length >= 10 || hasSymbolHint;
  return {
    raw,
    length,
    tokenCount: tokens.length,
    hasPath,
    hasSymbolHint,
    strong
  };
};

export const isStrongQuery = (metrics: QueryMetrics): boolean => metrics.strong;
