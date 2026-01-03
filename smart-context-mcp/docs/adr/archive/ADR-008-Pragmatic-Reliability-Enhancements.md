# ADR-008 (v2): Final Blueprint for Pragmatic Reliability

## 1. Context
This ADR is the final, implementation-ready blueprint for the first phase of reliability enhancements, superseding the initial draft of ADR-008. It incorporates critical pre-flight feedback from an expert review, addressing subtle but significant flaws in the backup strategy and Levenshtein logic. This document provides a clear, safe, and pragmatic path to immediate improvements in user trust and agent effectiveness.

## 2. Final Decision
Implementation will proceed based on the following hardened designs:

1.  **Race-Condition-Free Backups**: The backup mechanism will be modified to ensure the content backed up is the exact same content that was read at the beginning of the edit operation, preventing data loss from intermediate file modifications.
2.  **Fully Functional Levenshtein Logic**: The Levenshtein implementation will be corrected to properly score multiple candidates and select the single best match, rather than prematurely failing on ambiguity.
3.  **Actionable & Robust Feedback**: Error responses for ambiguity will be structured and actionable, and the backup retention policy will be non-blocking.

## 3. Finalized Design and Implementation Specification

### 3.1. Proposal 1: Race-Condition-Free Timestamped Backups
- **Design:**
  - **Core Logic Change**: The `EditorEngine.applyEdits` method reads the file content at the very beginning. **This exact `originalContent` variable** will be passed to a new `_createTimestampedBackup` method and written to the backup file. This completely closes the TOCTOU (Time-of-Check-to-Time-of-Use) window where the file could change between being read and being backed up.
  - **Backup Location & Naming**: Unchanged. `.mcp/backups/` with flattened, timestamped names (e.g., `src_components_Button.tsx_20251206T103000.bak`). Path encoding will handle Windows drive letters and separators gracefully.
  - **Retention Policy (Best-Effort)**: The retention policy (keep 10 most recent per file) will be executed in a `try...catch` block. If cleanup fails (e.g., permissions error), the failure will be logged as a warning, but the main `edit_file` operation will still return a success.
- **Testing Strategy:**
  - **Unit Test (Content Integrity):** Add a test that mocks an external file change *after* `readFileAsync` is called but *before* `writeFileAsync`. Assert that the created `.bak` file contains the **original content**, not the externally modified content.
  - **Unit Test (Retention Failure):** Mock the cleanup logic to throw an error. Assert that the `edit_file` operation still succeeds and returns a success message.

### 3.2. Proposal 2: Actionable Feedback Loop (Structured Ambiguity Error)
- **Design (Unchanged from v1):**
  - The `details: { conflictingLines: number[] }` field will be added to the structured JSON error response.
  - The `suggestion` string will explicitly list the conflicting line numbers and recommend using `lineRange` to disambiguate.
- **Testing Strategy (Unchanged from v1):**
  - Test that an ambiguous match error correctly populates `errorCode`, `details.conflictingLines`, and the actionable `suggestion` string.

### 3.3. Proposal 3: Fully Functional & Performant Levenshtein Mode
- **Design (Corrected Logic):**
  - **Safeguards (Unchanged)**: Candidate limit (> 10 fails), String length limit (< 256 chars fails).
  - **Corrected Implementation Logic in `findMatch`**:
    1.  Perform initial regex match to get `allMatches`.
    2.  Filter `allMatches` by context (`beforeContext`, `afterContext`, `lineRange`) to get `candidateMatches`.
    3.  **If `fuzzyMode === 'levenshtein'`:**
        a. Check performance safeguards (string length on `edit.targetString`, candidate count on `candidateMatches.length`). If violated, throw the appropriate specific error.
        b. **Score Candidates**: Map over `candidateMatches` to create an array of `{ match, distance }` objects by calculating the Levenshtein distance for each.
        c. **Find Best Match**: Identify the minimum distance among the scored candidates.
        d. **Threshold Check**: If `min_distance` is greater than the 30% error margin, throw a "No close match found" error.
        e. **Uniqueness Check**: Filter the scored candidates to find all matches with the `min_distance`. If this results in more than one match, throw an `AmbiguousMatch` error detailing the tie.
        f. If a single, unique best match is found, return it.
    4.  **Else (not Levenshtein mode):**
        a. If `candidateMatches.length !== 1`, throw an `AmbiguousMatch` or `TargetNotFound` error.
        b. Return the single `candidateMatches[0]`.
- **Testing Strategy:**
  - **Unit Test (Best Match Wins):** Create a file with 3 similar strings. Provide a `targetString` with a typo that is clearly closest to only one of them (e.g., distances are 2, 5, 8). Assert that the edit is correctly applied to the best match.
  - **Unit Test (Tie-Breaking):** Create a file where two candidates have the exact same Levenshtein distance from the target. Assert that the operation fails with an `AmbiguousMatch` error.

## 4. Next Steps
1.  **Final Approval**: This ADR (v2) is considered the final, actionable blueprint.
2.  **Implementation**: Proceed with implementation, starting with Proposal 1 (Backups), followed by Proposal 2 (Error Structure), and finally Proposal 3 (Levenshtein Logic).
3.  **Test Implementation**: Implement all specified test cases to ensure the hardened reliability.