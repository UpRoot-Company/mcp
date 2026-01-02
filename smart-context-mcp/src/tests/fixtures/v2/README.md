# v2 Test Fixtures

This directory contains test files for verifying EditResolver v2 behavior across various edge cases.

## Files

### `sample-service.ts`
- **Purpose:** Standard edit scenarios (exact match, single replacement)
- **Use Cases:**
  - Successful indexRange-based resolution
  - Typical method/property modifications
  - Benchmark baseline for `change.resolve_ms`

### `ambiguous-matches.ts`
- **Purpose:** Test AMBIGUOUS_MATCH error detection
- **Use Cases:**
  - Multiple identical method signatures
  - Similar function overloads
  - Verify lineRange suggestion in resolveErrors

### `large-file.ts`
- **Purpose:** Test MAX_LEVENSHTEIN_FILE_BYTES cost guardrail
- **Use Cases:**
  - Files exceeding 100KB threshold
  - Verify LEVENSHTEIN_BLOCKED error type
  - Ensure fuzzy matching is disabled for large files

## Usage in Tests

```typescript
import { readFileSync } from "fs";
import { join } from "path";

const fixturesDir = join(__dirname, "fixtures/v2");
const sampleService = readFileSync(join(fixturesDir, "sample-service.ts"), "utf-8");

// Test exact match resolution
const edits = [{ oldCode: "getActiveCount()", newCode: "getActiveUserCount()" }];
const result = await resolver.resolveAll(filePath, edits, sampleService);
expect(result.resolved[0].indexRange).toBeDefined();

// Test ambiguous match detection
const ambiguousEdits = [{ oldCode: "add(", newCode: "sum(" }];
const ambiguousResult = await resolver.resolveAll(filePath, ambiguousEdits, ambiguousContent);
expect(ambiguousResult.errors[0].type).toBe("AMBIGUOUS_MATCH");
expect(ambiguousResult.errors[0].lineRange).toBeDefined();
```

## Maintenance

When adding new fixtures:
1. Create file with clear purpose (documented in header comment)
2. Add entry to this README
3. Update integration tests to reference new fixture
4. Ensure file size is appropriate (small for most tests, large only for cost guardrail tests)

## Related Documentation

- ADR-042-005 §6: Cost Guardrails
- ADR-042-005 §7: Error Diagnostics
- [EditResolver.test.ts](../../engine/EditResolver.test.ts)
- [change.v2.integration.test.ts](../../orchestration/change.v2.integration.test.ts)
