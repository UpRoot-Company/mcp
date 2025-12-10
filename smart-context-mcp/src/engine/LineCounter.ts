export class LineCounter {
    private lineStarts: number[];

    constructor(content: string) {
        this.lineStarts = [0];
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '\n') {
                this.lineStarts.push(i + 1);
            }
        }
    }

    /**
     * Returns the 1-based line number for a given 0-based character position.
     * Uses binary search for O(log N) performance.
     */
    public getLineNumber(position: number): number {
        if (position < 0) return 1; // Fallback for invalid negative positions
        
        let low = 0;
        let high = this.lineStarts.length - 1;
        
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const start = this.lineStarts[mid];
            
            if (start === position) return mid + 1;
            
            if (start < position) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return high + 1;
    }

    public lineAt(index: number): number {
        return this.getLineNumber(index);
    }

    public getCharIndexForLine(lineNumber: number): number {
        if (lineNumber <= 1) return 0;
        if (lineNumber > this.lineStarts.length) {
            return this.lineStarts[this.lineStarts.length - 1] ?? 0;
        }
        return this.lineStarts[lineNumber - 1];
    }

    /**
     * Returns the total number of lines.
     */
    public get lineCount(): number {
        return this.lineStarts.length;
    }
}
