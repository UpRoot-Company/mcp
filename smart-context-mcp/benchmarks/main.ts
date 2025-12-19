import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- CORE ENGINE IMPORT ---
import { IncrementalIndexer } from '../src/indexing/IncrementalIndexer.js';
import { SkeletonGenerator } from '../src/ast/SkeletonGenerator.js';
import { SymbolIndex } from '../src/ast/SymbolIndex.js';
import { ModuleResolver } from '../src/ast/ModuleResolver.js';
import { DependencyGraph } from '../src/ast/DependencyGraph.js';
import { SearchEngine } from '../src/engine/Search.js';
import { NodeFileSystem } from '../src/platform/FileSystem.js';
import { QueryIntentDetector } from '../src/engine/search/QueryIntent.js';
import { FileProfiler } from '../src/engine/FileProfiler.js';

// --- FRAMEWORK ---
interface Metric {
    step: number;
    name: string;
    value: string | number;
    unit: string;
    status: '✅' | '⚠️' | '🚀';
}

async function runBenchmark() {
    console.log("==========================================================");
    console.log("🏅 Smart-Context-MCP 8-Step Optimized Diagnostics");
    console.log("==========================================================");

    const rootPath = process.cwd();
    const nfs = new NodeFileSystem(rootPath);
    const sg = new SkeletonGenerator();
    const metrics: Metric[] = [];

    // STEP 1: Cold Start Speed
    console.log("\n[Step 1] Cold Start Performance...");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bench-v2-'));
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(tempDir, `f${i}.ts`), `export const v${i}=${i};`);
    const s1 = performance.now();
    const si = new SymbolIndex(tempDir, sg, []);
    const mr = new ModuleResolver(tempDir);
    const dg = new DependencyGraph(tempDir, si, mr);
    const indexer = new IncrementalIndexer(tempDir, si, dg, undefined, mr, undefined, { watch: false, initialScan: true });
    await indexer.start();
    await indexer.waitForInitialScan();
    metrics.push({ step: 1, name: "Cold Start (500 Files)", value: performance.now() - s1, unit: "ms", status: '🚀' });

    // STEP 2: Incremental Scan
    console.log("[Step 2] Incremental Scan Latency...");
    const s2 = performance.now();
    // @ts-ignore
    await indexer.scanForNewFiles();
    metrics.push({ step: 2, name: "Incremental Scan", value: performance.now() - s2, unit: "ms", status: '🚀' });
    await indexer.stop();

    // STEP 3: Skeleton Generation Speed
    console.log("[Step 3] Skeleton Extraction Speed...");
    const largeFile = 'src/engine/Search.ts';
    const content = fs.readFileSync(largeFile, 'utf-8');
    const s3 = performance.now();
    await sg.generateSkeleton(largeFile, content);
    metrics.push({ step: 3, name: "Skeleton Gen (Search.ts)", value: performance.now() - s3, unit: "ms", status: '🚀' });

    // STEP 4: Token Savings Ratio
    console.log("[Step 4] Token Savings Ratio...");
    const skeleton = await sg.generateSkeleton(largeFile, content);
    const savings = (1 - (skeleton.length / content.length)) * 100;
    metrics.push({ step: 4, name: "Compression Ratio", value: savings, unit: "%", status: '✅' });

    // STEP 5: Search Intent Detection
    console.log("[Step 5] Search Intent Accuracy...");
    const detector = new QueryIntentDetector();
    const intents = [detector.detect("class SearchEngine"), detector.detect("config file")];
    const intentAcc = (intents[0] === 'symbol' && intents[1] === 'file') ? 100 : 0;
    metrics.push({ step: 5, name: "Intent Accuracy", value: intentAcc, unit: "%", status: '✅' });

    // STEP 6: Search Recall@1
    console.log("[Step 6] Search Recall@1 (Precision)...");
    const searchEngine = new SearchEngine(rootPath, nfs);
    await searchEngine.warmup();
    const results = await searchEngine.scout({ query: "class SearchEngine" });
    const recall = results[0]?.filePath.includes("Search.ts") ? 100 : 0;
    metrics.push({ step: 6, name: "Recall@1 (Top Match)", value: recall, unit: "%", status: '✅' });

    // STEP 7: Relationship Analysis Latency
    console.log("[Step 7] Relationship Analysis Latency...");
    const s7 = performance.now();
    await dg.getDependencies('src/engine/Search.ts', 'both');
    metrics.push({ step: 7, name: "Dep Graph Traversal", value: performance.now() - s7, unit: "ms", status: '🚀' });

        // STEP 8: File Profiling Latency
    console.log("[Step 8] File Profiling Speed...");
    const s8 = performance.now();
    FileProfiler.analyzeMetadata(content, 'src/engine/Search.ts');
    metrics.push({ step: 8, name: "Profiling (Search.ts)", value: performance.now() - s8, unit: "ms", status: '🚀' });

    // --- REPORTING ---
    let reportMd = `# 🏆 MCP Comprehensive Performance Report\n\nGenerated: ${new Date().toLocaleString()}\n\n`;
    reportMd += `| Step | Metric | Value | Unit | Status |\n| :--- | :--- | :--- | :--- | :--- |\n`;
    for (const m of metrics) {
        const val = typeof m.value === 'number' ? (m.unit === '%' ? m.value.toFixed(1) : m.value.toFixed(3)) : m.value;
        reportMd += `| ${m.step} | ${m.name} | ${val} | ${m.unit} | ${m.status} |\n`;
    }

    const reportPath = path.resolve(process.cwd(), `benchmarks/reports/full-report-${Date.now()}.md`);
    if (!fs.existsSync(path.dirname(reportPath))) fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, reportMd);

    console.log("\n==========================================================");
    console.log(`✅ DIAGNOSTICS COMPLETED. Report: ${reportPath}`);
    console.log("==========================================================");

    fs.rmSync(tempDir, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 100);
}

runBenchmark().catch(err => { console.error(err); process.exit(1); });
