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
});
