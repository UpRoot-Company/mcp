
import { SmartContextServer } from "../../index.js";
import * as fs from "fs";
import * as path from "path";

describe('Performance - edit_file', () => {
    let server: SmartContextServer;
    const perfTestDir = path.join(__dirname, 'perf_files');
    const largeFileName = 'large_file.txt';

    beforeAll(() => {
        if (!fs.existsSync(perfTestDir)) {
            fs.mkdirSync(perfTestDir);
        }

        const uniqueTarget = 'UNIQUE_TARGET_STRING_FOR_PERF_TEST';
        // Create a 1MB file for performance testing
        const largeContent = uniqueTarget + 'a'.repeat(1024 * 1024 - uniqueTarget.length);
        fs.writeFileSync(path.join(perfTestDir, largeFileName), largeContent);

        server = new SmartContextServer(perfTestDir);
    });

    afterAll(() => {
        if (fs.existsSync(perfTestDir)) {
            fs.rmSync(perfTestDir, { recursive: true, force: true });
        }
    });

    it('should perform edits on a large file in a reasonable time', async () => {
        const startTime = Date.now();

        const args = {
            filePath: largeFileName,
            edits: [
                { targetString: 'UNIQUE_TARGET_STRING_FOR_PERF_TEST', replacementString: 'REPLACED' }
            ]
        };

        const response = await (server as any).handleCallTool('edit_file', args);

        const endTime = Date.now();
        console.log(`[PERF] edit_file took ${endTime - startTime}ms`);

        expect(response.isError).toBeFalsy();
    }, 10000); // 10 seconds timeout for this test
});
