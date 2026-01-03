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
function getArgValue(argv, name) {
    const idx = argv.indexOf(name);
    if (idx === -1)
        return null;
    const value = argv[idx + 1];
    return value ? String(value) : null;
}
function readScenario(rootPath, scenarioName) {
    const safeName = scenarioName.replace(/[^a-zA-Z0-9._-]/g, "");
    const scenarioPath = path.join(rootPath, "benchmarks", "scenarios", `${safeName}.json`);
    if (!fs.existsSync(scenarioPath)) {
        throw new Error(`Scenario not found: ${scenarioPath}`);
    }
    const raw = fs.readFileSync(scenarioPath, "utf8");
    return JSON.parse(raw);
}
function bytesToMb(bytes) {
    return bytes / (1024 * 1024);
}
function percentile(values, p) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}
function directorySizeBytes(dir) {
    if (!fs.existsSync(dir))
        return 0;
    let total = 0;
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const absPath = path.join(current, entry.name);
            try {
                if (entry.isDirectory()) {
                    stack.push(absPath);
                }
                else if (entry.isFile()) {
                    total += fs.statSync(absPath).size;
                }
            }
            catch {
                // ignore unreadable entries
            }
        }
    }
    return total;
}
async function runBenchmark() {
    console.log("==========================================================");
    console.log("🏅 Smart-Context-MCP 8-Step Optimized Diagnostics");
    console.log("==========================================================");
    const argv = process.argv.slice(2);
    const rootPath = process.cwd();
    const nfs = new NodeFileSystem(rootPath);
    const sg = new SkeletonGenerator();
    const metrics = [];
    const scenarioName = getArgValue(argv, "--scenario");
    const scenario = scenarioName
        ? readScenario(rootPath, scenarioName)
        : {
            name: "default",
            rootPath,
            includeGlobs: ["src/**"],
            excludeGlobs: ["benchmarks/**"],
            queries: [{ query: "class QueryIntentDetector", expectTop: "src/engine/search/QueryIntent.ts" }]
        };
    // STEP 1: Cold Start Speed
    console.log("\n[Step 1] Cold Start Performance...");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bench-v2-'));
    for (let i = 0; i < 500; i++)
        fs.writeFileSync(path.join(tempDir, `f${i}.ts`), `export const v${i}=${i};`);
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
    await sg.generateSkeleton(largeFile, content); // warm parser/cache
    const s3 = performance.now();
    const skeleton = await sg.generateSkeleton(largeFile, content);
    metrics.push({ step: 3, name: "Skeleton Gen (Search.ts)", value: performance.now() - s3, unit: "ms", status: '🚀' });
    // STEP 4: Token Savings Ratio
    console.log("[Step 4] Token Savings Ratio...");
    const savings = (1 - (skeleton.length / content.length)) * 100;
    metrics.push({ step: 4, name: "Compression Ratio", value: savings, unit: "%", status: '✅' });
    // STEP 5: Search Intent Detection
    console.log("[Step 5] Search Intent Accuracy...");
    const detector = new QueryIntentDetector();
    const intents = [detector.detect("class SearchEngine"), detector.detect("config file")];
    const intentAcc = (intents[0] === 'symbol' && intents[1] === 'file') ? 100 : 0;
    metrics.push({ step: 5, name: "Intent Accuracy", value: intentAcc, unit: "%", status: '✅' });
    // STEP 6: Search Recall@K (scenario)
    console.log("[Step 6] Search Recall (scenario)...");
    const searchEngine = new SearchEngine(rootPath, nfs);
    await searchEngine.warmup();
    const queries = scenario.queries ?? [];
    let hitsAt1 = 0;
    let hitsAt10 = 0;
    const searchLatencies = [];
    for (const q of queries) {
        const s6 = performance.now();
        const results = await searchEngine.scout({
            query: q.query,
            includeGlobs: scenario.includeGlobs,
            excludeGlobs: scenario.excludeGlobs,
            groupByFile: true,
            deduplicateByContent: true
        });
        const elapsed = performance.now() - s6;
        searchLatencies.push(elapsed);
        if (results[0]?.filePath === q.expectTop)
            hitsAt1++;
        if (results.slice(0, 10).some(r => r.filePath === q.expectTop))
            hitsAt10++;
    }
    const recallAt1 = queries.length > 0 ? (hitsAt1 / queries.length) * 100 : 0;
    const recallAt10 = queries.length > 0 ? (hitsAt10 / queries.length) * 100 : 0;
    const searchP50 = percentile(searchLatencies, 50);
    const searchP95 = percentile(searchLatencies, 95);
    const searchP99 = percentile(searchLatencies, 99);
    metrics.push({ step: 6, name: "Recall@1 (scenario)", value: recallAt1, unit: "%", status: '✅' });
    metrics.push({ step: 6, name: "Recall@10 (scenario)", value: recallAt10, unit: "%", status: '✅' });
    metrics.push({ step: 6, name: "Search p50", value: searchP50, unit: "ms", status: '🚀' });
    metrics.push({ step: 6, name: "Search p95", value: searchP95, unit: "ms", status: '🚀' });
    metrics.push({ step: 6, name: "Search p99", value: searchP99, unit: "ms", status: '🚀' });
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
    if (!fs.existsSync(path.dirname(reportPath)))
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const mem = process.memoryUsage();
    const smartContextDir = path.join(rootPath, ".smart-context");
    const smartContextBytes = directorySizeBytes(smartContextDir);
    // P2 Storage breakdown
    const embeddingsPackDir = path.join(smartContextDir, "storage", "v1", "embeddings");
    const vectorIndexDir = path.join(smartContextDir, "vector-index");
    const trigramIndexPath = path.join(smartContextDir, "storage", "trigram-index.json");
    const embeddingsPackBytes = fs.existsSync(embeddingsPackDir) ? directorySizeBytes(embeddingsPackDir) : 0;
    const vectorIndexBytes = fs.existsSync(vectorIndexDir) ? directorySizeBytes(vectorIndexDir) : 0;
    const trigramIndexBytes = fs.existsSync(trigramIndexPath) ? fs.statSync(trigramIndexPath).size : 0;
    // P2 Metrics collection
    const p2Metrics = {
        searchLatencyP50: searchP50,
        searchLatencyP95: searchP95,
        searchLatencyP99: searchP99,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        embeddingsPackBytes,
        vectorIndexBytes,
        trigramIndexBytes,
        totalStorageBytes: smartContextBytes,
        recallAt1,
        recallAt10,
        queryCount: queries.length,
        embeddingFormat: scenario.embeddingPack?.format,
        vectorIndexMode: scenario.vectorIndex?.mode
    };
    reportMd += `\n\n## Scenario\n\n- name: ${scenario.name ?? scenarioName ?? "default"}\n`;
    if (scenario.description)
        reportMd += `- description: ${scenario.description}\n`;
    reportMd += `- includeGlobs: ${(scenario.includeGlobs ?? []).join(", ")}\n- excludeGlobs: ${(scenario.excludeGlobs ?? []).join(", ")}\n- queries: ${queries.length}\n`;
    if (scenario.vectorIndex) {
        reportMd += `- vectorIndex.mode: ${scenario.vectorIndex.mode ?? "auto"}\n`;
        reportMd += `- vectorIndex.shards: ${scenario.vectorIndex.shards ?? "off"}\n`;
    }
    if (scenario.embeddingPack) {
        reportMd += `- embeddingPack.format: ${scenario.embeddingPack.format ?? "float32"}\n`;
    }
    reportMd += `\n## P2 Metrics (ADR-042-003)\n\n`;
    reportMd += `### Latency (ms)\n\n`;
    reportMd += `- Search p50: ${p2Metrics.searchLatencyP50.toFixed(3)}\n`;
    reportMd += `- Search p95: ${p2Metrics.searchLatencyP95.toFixed(3)}\n`;
    reportMd += `- Search p99: ${p2Metrics.searchLatencyP99.toFixed(3)}\n`;
    reportMd += `\n### Memory (MB)\n\n`;
    reportMd += `- RSS: ${bytesToMb(p2Metrics.rssBytes).toFixed(1)}\n`;
    reportMd += `- Heap Used: ${bytesToMb(p2Metrics.heapUsedBytes).toFixed(1)}\n`;
    reportMd += `- Heap Total: ${bytesToMb(p2Metrics.heapTotalBytes).toFixed(1)}\n`;
    reportMd += `\n### Storage (MB)\n\n`;
    reportMd += `- Embeddings Pack: ${bytesToMb(p2Metrics.embeddingsPackBytes).toFixed(1)}\n`;
    reportMd += `- Vector Index: ${bytesToMb(p2Metrics.vectorIndexBytes).toFixed(1)}\n`;
    reportMd += `- Trigram Index: ${bytesToMb(p2Metrics.trigramIndexBytes).toFixed(1)}\n`;
    reportMd += `- Total Storage: ${bytesToMb(p2Metrics.totalStorageBytes).toFixed(1)}\n`;
    reportMd += `\n### Quality\n\n`;
    reportMd += `- Recall@1: ${p2Metrics.recallAt1.toFixed(1)}%\n`;
    reportMd += `- Recall@10: ${p2Metrics.recallAt10.toFixed(1)}%\n`;
    reportMd += `\n## System Metrics (Legacy)\n\n- rssMB: ${bytesToMb(mem.rss).toFixed(1)}\n- heapUsedMB: ${bytesToMb(mem.heapUsed).toFixed(1)}\n- smartContextDirMB: ${bytesToMb(smartContextBytes).toFixed(1)}\n`;
    fs.writeFileSync(reportPath, reportMd);
    console.log("\n==========================================================");
    console.log(`✅ DIAGNOSTICS COMPLETED. Report: ${reportPath}`);
    console.log("==========================================================");
    fs.rmSync(tempDir, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 100);
}
runBenchmark().catch(err => { console.error(err); process.exit(1); });
