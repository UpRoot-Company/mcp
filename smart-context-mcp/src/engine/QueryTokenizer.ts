/**
 * Tokenizes search queries with support for quoted phrases
 */
export class QueryTokenizer {
  /**
   * Tokenize query into keywords
   * Supports quoted phrases: "foo bar" baz → ["foo bar", "baz"]
   */
  tokenize(query: string): string[] {
    const tokens: string[] = [];
    
    // Match quoted phrases or single words
    const regex = /"([^"]+)"|\S+/g;
    let match;
    
    while ((match = regex.exec(query)) !== null) {
      // Quoted phrase: use as-is (without quotes)
      if (match[1]) {
        tokens.push(match[1]);
      }
      // Single word: keep original casing; downstream logic handles normalization
      else {
        tokens.push(match[0]);
      }
    }
    
    return tokens;
  }
  
  /**
   * Normalize query for better matching
   * - Remove punctuation
   * - Normalize whitespace
   * - Handle CamelCase splitting
   */
  normalize(query: string): string {
    return query
      .replace(/[^a-zA-Z0-9\s]/g, ' ') // Remove punctuation
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Split CamelCase
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
      .toLowerCase();
  }
}
