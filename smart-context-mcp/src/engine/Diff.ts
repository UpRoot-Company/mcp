type ChangeType = 'equal' | 'insert' | 'delete';

interface Change {
    type: ChangeType;
    value: string;
}

interface DiffSummary {
    diff: string;
    added: number;
    removed: number;
}

export class MyersDiff {
    public static diffLines(text1: string, text2: string): string {
        return this.diffLinesStructured(text1, text2).diff;
    }

    public static diffLinesStructured(text1: string, text2: string): DiffSummary {
        const lines1 = text1.split('\n');
        const lines2 = text2.split('\n');
        const changes = this.computeDiff(lines1, lines2);
        const diff = this.formatUnifiedDiff(changes);

        let added = 0;
        let removed = 0;
        for (const change of changes) {
            if (change.type === 'insert') {
                added++;
            } else if (change.type === 'delete') {
                removed++;
            }
        }

        return { diff, added, removed };
    }

    private static computeDiff(a: string[], b: string[]): Change[] {
        const n = a.length;
        const m = b.length;
        const max = n + m;
        const v: { [key: number]: number } = { 1: 0 };
        const trace: { [key: number]: number }[] = [];

        // Myers Algorithm Main Loop
        for (let d = 0; d <= max; d++) {
            trace.push({ ...v });
            for (let k = -d; k <= d; k += 2) {
                let x: number;
                if (k === -d || (k !== d && v[k - 1] < v[k + 1])) {
                    x = v[k + 1]; // Down (Insertion)
                } else {
                    x = v[k - 1] + 1; // Right (Deletion)
                }

                let y = x - k;
                while (x < n && y < m && a[x] === b[y]) {
                    x++;
                    y++;
                }
                v[k] = x;
                if (x >= n && y >= m) {
                    return this.backtrack(trace, a, b);
                }
            }
        }
        return [];
    }

    private static backtrack(trace: { [key: number]: number }[], a: string[], b: string[]): Change[] {
        const changes: Change[] = [];
        let x = a.length;
        let y = b.length;

        for (let d = trace.length - 1; d >= 0; d--) {
            const v = trace[d];
            const k = x - y;
            const prevK = (k === -d || (k !== d && v[k - 1] < v[k + 1])) ? k + 1 : k - 1;
            const prevX = v[prevK];
            const prevY = prevX - prevK;

            while (x > prevX && y > prevY) {
                changes.unshift({ type: 'equal', value: a[x - 1] });
                x--;
                y--;
            }

            if (d > 0) {
                if (x === prevX) {
                    changes.unshift({ type: 'insert', value: b[y - 1] });
                    y--;
                } else {
                    changes.unshift({ type: 'delete', value: a[x - 1] });
                    x--;
                }
            }
        }
        return changes;
    }

    private static formatUnifiedDiff(changes: Change[]): string {
        let output = '';
        changes.forEach(change => {
            if (change.type === 'equal') {
                output += `  ${change.value}\n`;
            } else if (change.type === 'insert') {
                output += `+ ${change.value}\n`;
            } else if (change.type === 'delete') {
                output += `- ${change.value}\n`;
            }
        });
        return output;
    }
}
