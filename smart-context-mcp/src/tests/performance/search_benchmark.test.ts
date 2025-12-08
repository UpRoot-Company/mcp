
import { SmartContextServer } from "../../index.js";
import * as fs from "fs";
import * as path from "path";
import { FileSearchResult } from "../../types.js";

describe('Performance - search_files', () => {
    let server: SmartContextServer;
    const perfTestDir = path.join(__dirname, 'perf_files');

    beforeAll(() => {
        if (!fs.existsSync(perfTestDir)) {
            fs.mkdirSync(perfTestDir);
        }

        for (let i = 0; i < 100; i++) {
            const content = `File ${i}\n` + 'some random text '.repeat(100) + 'unique_keyword_' + i;
            fs.writeFileSync(path.join(perfTestDir, `perf_file_${i}.txt`), content);
        }

        server = new SmartContextServer(perfTestDir);
    });

    afterAll(() => {
        if (fs.existsSync(perfTestDir)) {
            fs.rmSync(perfTestDir, { recursive: true, force: true });
        }
    });

    it('should search 100 files in a reasonable time', async () => {
        const startTime = Date.now();

        const args = { keywords: ['unique_keyword_50'] };
        const response = await (server as any).handleCallTool('search_files', args);

        const endTime = Date.now();
        console.log(`[PERF] search_files took ${endTime - startTime}ms`);

        expect(response.isError).toBeFalsy();
        const result: FileSearchResult[] = JSON.parse(response.content[0].text);
        expect(result).toHaveLength(1);
    }, 10000); // 10 seconds timeout for this test
});
