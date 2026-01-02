import { describe, beforeEach, afterEach, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SmartContextServer } from '../index.js';

const runTool = async (server: SmartContextServer, toolName: string, args: any) => {
  const response = await (server as any).handleCallTool(toolName, args);
  expect(response).toBeDefined();
  const payload = JSON.parse(response.content[0].text);
  return payload;
};

describe('SmartContextServer - change integration', () => {
  let server: SmartContextServer;
  let testRoot: string;

  beforeEach(async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'change-test-'));
    fs.mkdirSync(path.join(testRoot, 'src'), { recursive: true });
    server = new SmartContextServer(testRoot);
  });

  afterEach(async () => {
    await server.shutdown();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('applies legacy target/replacement edits via change tool', async () => {
    const relPath = path.join('src', 'demo.ts');
    const absPath = path.join(testRoot, relPath);
    fs.writeFileSync(absPath, 'const message = "hello";\n', 'utf-8');

    const result = await runTool(server, 'change', {
      intent: 'Replace greeting',
      targetFiles: [relPath],
      edits: [{
        target: 'const message = "hello";',
        replacement: 'const message = "hi";'
      }],
      options: { dryRun: false, includeImpact: false }
    });

    expect(result.success).toBe(true);
    const updated = fs.readFileSync(absPath, 'utf-8');
    expect(updated).toContain('const message = "hi";');
  });

  it('applies batch edits across multiple files', async () => {
    const relA = path.join('src', 'batch-a.ts');
    const relB = path.join('src', 'batch-b.ts');
    const absA = path.join(testRoot, relA);
    const absB = path.join(testRoot, relB);
    fs.writeFileSync(absA, "console.log('File A Original');\n", 'utf-8');
    fs.writeFileSync(absB, "console.log('File B Original');\n", 'utf-8');

    const result = await runTool(server, 'change', {
      intent: 'Modify A and B together',
      targetFiles: [relA, relB],
      edits: [
        { filePath: relA, targetString: "console.log('File A Original');", replacement: "console.log('File A Modified');" },
        { filePath: relB, targetString: "console.log('File B Original');", replacement: "console.log('File B Modified');" }
      ],
      options: { dryRun: false, includeImpact: false, batchMode: true }
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(absA, 'utf-8')).toContain("console.log('File A Modified');");
    expect(fs.readFileSync(absB, 'utf-8')).toContain("console.log('File B Modified');");
  });

  it('rolls back batch when one edit fails', async () => {
    const relA = path.join('src', 'rollback-a.ts');
    const relB = path.join('src', 'rollback-b.ts');
    const absA = path.join(testRoot, relA);
    const absB = path.join(testRoot, relB);
    fs.writeFileSync(absA, "console.log('File A Original');\n", 'utf-8');
    fs.writeFileSync(absB, "console.log('File B Original');\n", 'utf-8');

    const result = await runTool(server, 'change', {
      intent: 'Modify A and B together (should rollback)',
      targetFiles: [relA, relB],
      edits: [
        { filePath: relA, targetString: "console.log('File A Original');", replacement: "console.log('File A Modified');" },
        { filePath: relB, targetString: "console.log('File B WRONG TEXT');", replacement: "console.log('File B Modified');" }
      ],
      options: { dryRun: false, includeImpact: false, batchMode: true }
    });

    expect(result.success).toBe(false);
    expect(fs.readFileSync(absA, 'utf-8')).toContain("console.log('File A Original');");
    expect(fs.readFileSync(absB, 'utf-8')).toContain("console.log('File B Original');");
  });

  it('fails batch mapping when edits are missing filePath', async () => {
    const relA = path.join('src', 'map-a.ts');
    const relB = path.join('src', 'map-b.ts');
    const absA = path.join(testRoot, relA);
    const absB = path.join(testRoot, relB);
    fs.writeFileSync(absA, "console.log('File A Original');\n", 'utf-8');
    fs.writeFileSync(absB, "console.log('File B Original');\n", 'utf-8');

    const result = await runTool(server, 'change', {
      intent: 'Modify A and B together (mapping error)',
      targetFiles: [relA, relB],
      edits: [
        { targetString: "console.log('File A Original');", replacement: "console.log('File A Modified');" }
      ],
      options: { dryRun: false, includeImpact: false, batchMode: true }
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("filePath");
  });
});
