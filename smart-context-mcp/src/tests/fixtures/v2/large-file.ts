/**
 * Large file to test MAX_LEVENSHTEIN_FILE_BYTES guardrail
 * This file exceeds 100KB to trigger levenshtein blocking
 */

// Generate large content to exceed 100KB threshold (100,000 bytes)
const LARGE_TEXT_BLOCK = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt
ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation
ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in
reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur
sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id
est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium
doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et
quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas
sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione
voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet.
`.repeat(1000); // ~700 bytes * 1000 = 700KB total

export class LargeService {
  private data1: string = LARGE_TEXT_BLOCK;

  constructor() {
    // Target edit location - should trigger LEVENSHTEIN_BLOCKED when fuzzyMode=levenshtein
    console.log("Service initialized");
  }

  processData(): string {
    return this.data1.toUpperCase();
  }
}
