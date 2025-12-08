import { LineCounter } from "../engine/LineCounter.js";

describe("LineCounter", () => {
  it("should handle empty string", () => {
    const counter = new LineCounter("");
    expect(counter.getLineNumber(0)).toBe(1);
    expect(counter.lineCount).toBe(1);
  });

  it("should handle single line string", () => {
    const counter = new LineCounter("hello world");
    expect(counter.getLineNumber(0)).toBe(1);
    expect(counter.getLineNumber(5)).toBe(1);
    expect(counter.getLineNumber(10)).toBe(1);
    expect(counter.lineCount).toBe(1);
  });

  it("should handle multi-line string", () => {
    // 012345678901
    // hello\nworld
    const content = "hello\nworld";
    const counter = new LineCounter(content);
    
    // 'h' at 0 -> line 1
    expect(counter.getLineNumber(0)).toBe(1);
    // '\n' at 5 -> line 1 (technically end of line 1, or start of line 2 depending on interpretation, 
    // but in our logic `lineStarts` are [0, 6]. 
    // 5 < 6, so high=0, returns 1. Correct.)
    expect(counter.getLineNumber(5)).toBe(1);
    
    // 'w' at 6 -> line 2
    expect(counter.getLineNumber(6)).toBe(2);
    // 'd' at 10 -> line 2
    expect(counter.getLineNumber(10)).toBe(2);
    
    expect(counter.lineCount).toBe(2);
  });

  it("should handle multiple newlines", () => {
    // 01234 5 678901
    // line1\n\nline3
    const content = "line1\n\nline3";
    const counter = new LineCounter(content);
    
    // lineStarts: [0, 6, 7]
    
    expect(counter.getLineNumber(0)).toBe(1); // 'l'
    expect(counter.getLineNumber(5)).toBe(1); // '\n'
    
    expect(counter.getLineNumber(6)).toBe(2); // Second '\n' starts at 6?
    // Wait. "line1" is indices 0-4. '\n' is 5.
    // lineStarts: [0]
    // i=5 (\n) -> push 6. lineStarts: [0, 6]
    // i=6 (\n) -> push 7. lineStarts: [0, 6, 7]
    
    // getLineNumber(6):
    // mid=1 (val 6) == 6 -> returns 2. Correct.
    expect(counter.getLineNumber(6)).toBe(2); 
    
    expect(counter.getLineNumber(7)).toBe(3); // 'l' of line3
    expect(counter.lineCount).toBe(3);
  });

  it("should handle trailing newline", () => {
    // 012345
    // hello\n
    const content = "hello\n";
    const counter = new LineCounter(content);
    
    // lineStarts: [0, 6]
    expect(counter.getLineNumber(5)).toBe(1);
    expect(counter.getLineNumber(6)).toBe(2); // Position 6 is past end, but technically line 2 starts there (empty)
    expect(counter.lineCount).toBe(2);
  });

  it("should handle binary search edge cases", () => {
    // Create a large number of lines
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`).join("\n");
    const counter = new LineCounter(lines);
    
    // Test first line
    expect(counter.getLineNumber(0)).toBe(1);
    
    // Test last line
    const lastPos = lines.length - 1;
    expect(counter.getLineNumber(lastPos)).toBe(1000);
  });
  
  it("should handle negative position fallback", () => {
    const counter = new LineCounter("abc");
    expect(counter.getLineNumber(-1)).toBe(1);
  });
});
