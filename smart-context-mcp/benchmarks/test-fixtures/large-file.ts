/**
 * Large file to test MAX_LEVENSHTEIN_FILE_BYTES guardrail
 * This file should exceed 100KB when concatenated with enough comments
 */

// Generate a large block of comments to push file size over 100KB
// Each line is ~80 chars, need ~1250+ lines for 100KB

/**
 * PADDING BLOCK START - DO NOT EDIT
 * Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt
 * ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation
 * ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in
 * reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur
 * sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id
 * est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium
 * doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et
 * quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas
 * sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione
 * voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet,
 * consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et
 * dolore magnam aliquam quaerat voluptatem. Ut enim ad minima veniam, quis nostrum
 * exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi consequatur
 * [... repeat 100+ times to reach 100KB+ ...]
 */

// This pattern repeated enough times will exceed MAX_LEVENSHTEIN_FILE_BYTES
const PADDING = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor
incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
`.repeat(500); // Approximately 50KB per 500 repetitions

export class LargeService {
  private data: string = PADDING;

  constructor() {
    // Target edit location - should trigger LEVENSHTEIN_BLOCKED
    console.log("Service initialized");
  }

  processData(): string {
    return this.data.toUpperCase();
  }
}

// Additional padding to ensure file exceeds 100KB
export const METADATA = PADDING.repeat(10);
