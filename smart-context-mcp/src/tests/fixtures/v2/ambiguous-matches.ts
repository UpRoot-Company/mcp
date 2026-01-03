/**
 * Test file with intentionally ambiguous patterns
 * Used to verify AMBIGUOUS_MATCH error detection
 */

export class Calculator {
  // Multiple methods with similar signatures to trigger ambiguity
  add(a: number, b: number): number {
    return a + b;
  }

  addAll(...numbers: number[]): number {
    return numbers.reduce((sum, n) => sum + n, 0);
  }
}

export class MathHelper {
  // Another class with same method name - creates ambiguity
  add(a: number, b: number): number {
    return a + b;
  }
}

export class StringUtils {
  static concat(...parts: string[]): string {
    return parts.join("");
  }
}

// Standalone functions with similar patterns
export function processStringData(input: string): string {
  return input.toUpperCase();
}

export function processNumberData(input: number): string {
  return input.toString();
}

export function processBooleanData(input: boolean): string {
  return input ? "true" : "false";
}
