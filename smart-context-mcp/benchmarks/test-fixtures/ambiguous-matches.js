/**
 * Test file with intentionally ambiguous patterns
 * Used to verify AMBIGUOUS_MATCH error detection
 */
export class Calculator {
    // Multiple methods with similar signatures to trigger ambiguity
    add(a, b) {
        return a + b;
    }
    addAll(...numbers) {
        return numbers.reduce((sum, n) => sum + n, 0);
    }
}
export class MathHelper {
    // Another class with same method name - creates ambiguity
    add(a, b) {
        return a + b;
    }
}
export class StringUtils {
    static concat(...parts) {
        return parts.join("");
    }
}
// Standalone functions with similar patterns
export function processStringData(input) {
    return input.toUpperCase();
}
export function processNumberData(input) {
    return input.toString();
}
export function processBooleanData(input) {
    return input ? "true" : "false";
}
