import { spawnSync } from "child_process";
import { existsSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(moduleDir, "..");
const cliPath = path.join(rootDir, "dist", "cli", "build-markdown-wasm.js");

if (!existsSync(cliPath)) {
  console.error(`Missing ${cliPath}. Run "npm run build" first.`);
  process.exit(2);
}

const cases = [
  { args: ["--help"], expect: 0, label: "help" },
  { args: [], expect: 1, label: "missing args" },
  { args: ["--source", "/path/does/not/exist"], expect: 2, label: "missing source" }
];

for (const testCase of cases) {
  const result = spawnSync("node", [cliPath, ...testCase.args], { stdio: "inherit" });
  const code = result.status ?? 0;
  if (code !== testCase.expect) {
    console.error(`Case "${testCase.label}" failed: expected ${testCase.expect}, got ${code}`);
    process.exit(1);
  }
}

console.log("Markdown wasm CLI smoke tests passed.");
