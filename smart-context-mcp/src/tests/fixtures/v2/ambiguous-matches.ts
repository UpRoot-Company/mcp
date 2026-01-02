/**
 * Test file with intentionally ambiguous patterns
 * Used to verify AMBIGUOUS_MATCH error detection
 */

export class Calculator {
  // First occurrence of "add" method
  addNumbers(a: number, b: number): number {
    return a + b;
  }

  // Second occurrence with similar name
  addStrings(a: string, b: string): string {
    return a + b;
  }

  // Third occurrence with different signature
  addAll(...numbers: number[]): number {
    return numbers.reduce((sum, n) => sum + n, 0);
  }
}

export class StringUtils {
  // Another "add" context - should create ambiguity
  static add(str1: string, str2: string): string {
    return str1 + str2;
  }

  static concat(...parts: string[]): string {
    return parts.join("");
  }
}

// Multiple similar patterns that can cause ambiguity when searching
export function processStringData(input: string): string {
  return input.toUpperCase();
}

export function processNumberData(input: number): string {
  return input.toString();
}

export function processBooleanData(input: boolean): string {
  return input ? "true" : "false";
}
