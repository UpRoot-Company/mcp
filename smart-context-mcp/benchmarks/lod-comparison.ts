import { AstManager } from '../src/ast/AstManager';
import { FeatureFlags } from '../src/config/FeatureFlags';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { LOD_LEVEL, LODPromotionStats } from '../src/types.js';

type ScenarioResult = {
    scenario: string;
    minLOD: LOD_LEVEL;
    files: number;
    totalTimeMs: number;
    avgTimePerFileMs: number;
    memoryUsedMB: number;
    lodStats: LODPromotionStats;
};

const TARGET_LOD1_AVG_MS = 2;

async function runBenchmark() {
    FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
    FeatureFlags.set(FeatureFlags.TOPOLOGY_SCANNER_ENABLED, true);
    FeatureFlags.set(FeatureFlags.DUAL_WRITE_VALIDATION, false);
    
    console.log('============================================================');
    console.log('LOD Performance Comparison Benchmark (ADR-043 Final)');
    console.log('============================================================');

    const testFiles = findTestFiles('src', 50);
    console.log(`Found ${testFiles.length} test files\n`);

    const scenarios = [
        { label: 'Full AST (LOD 3) - Baseline', lod: 3 as LOD_LEVEL },
        { label: 'Topology Scan (LOD 1) - Optimized', lod: 1 as LOD_LEVEL }
    ];

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
        const result = await runScenario(scenario.label, scenario.lod, testFiles);
        results.push(result);
        logScenarioResult(result);
    }

    const [fullAst, topology] = results;
    if (fullAst && topology) {
        const improvement = fullAst.totalTimeMs / topology.totalTimeMs;
        console.log('------------------------------------------------------------');
        console.log(`Improvement: ${improvement.toFixed(2)}x faster (LOD 1 vs LOD 3)`);
    }

    const lod1 = results.find(r => r.minLOD === 1);
    if (lod1) {
        const pass = lod1.avgTimePerFileMs <= TARGET_LOD1_AVG_MS;
        console.log(`Target Check: LOD 1 avg <= ${TARGET_LOD1_AVG_MS}ms → ${pass ? 'PASS' : 'FAIL'} (${lod1.avgTimePerFileMs.toFixed(2)}ms)`);
    }

    await writeReport(results);
    await AstManager.resetForTestingAsync();
}

async function runScenario(label: string, minLOD: LOD_LEVEL, files: string[]): Promise<ScenarioResult> {
    console.log(`Scenario: ${label}`);
    await AstManager.resetForTestingAsync();
    const manager = AstManager.getInstance();
    const start = performance.now();

    for (const file of files) {
        try {
            await manager.ensureLOD({ path: file, minLOD });
        } catch (e) {
            console.error(`  - Failed LOD ${minLOD} for ${file}:`, e instanceof Error ? e.message : e);
        }
    }

    const totalTimeMs = performance.now() - start;
    const avgTimePerFileMs = totalTimeMs / Math.max(1, files.length);
    const memoryUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;

    return {
        scenario: label,
        minLOD,
        files: files.length,
        totalTimeMs,
        avgTimePerFileMs,
        memoryUsedMB,
        lodStats: manager.promotionStats()
    };
}

function logScenarioResult(result: ScenarioResult): void {
    console.log('------------------------------------------------------------');
    console.log(`${result.scenario}`);
    console.log(`  Files: ${result.files}`);
    console.log(`  Total Time: ${result.totalTimeMs.toFixed(2)}ms`);
    console.log(`  Avg/File: ${result.avgTimePerFileMs.toFixed(2)}ms`);
    console.log(`  Memory: ${result.memoryUsedMB.toFixed(2)} MB`);
    console.log(`  Promotions l0→l1: ${result.lodStats.l0_to_l1}, l1→l2: ${result.lodStats.l1_to_l2}, l2→l3: ${result.lodStats.l2_to_l3}`);
}

async function writeReport(results: ScenarioResult[]): Promise<void> {
    const reportsDir = path.join('benchmarks', 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, `lod-final-${Date.now()}.md`);
    const lines: string[] = [];

    lines.push('# LOD Benchmark Report');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    for (const result of results) {
        lines.push(`## ${result.scenario}`);
        lines.push(`- Files: ${result.files}`);
        lines.push(`- Requested LOD: ${result.minLOD}`);
        lines.push(`- Total Time: ${result.totalTimeMs.toFixed(2)} ms`);
        lines.push(`- Avg/File: ${result.avgTimePerFileMs.toFixed(2)} ms`);
        lines.push(`- Memory: ${result.memoryUsedMB.toFixed(2)} MB`);
        lines.push(`- Promotions: l0→l1=${result.lodStats.l0_to_l1}, l1→l2=${result.lodStats.l1_to_l2}, l2→l3=${result.lodStats.l2_to_l3}`);
        lines.push('');
    }

    if (results.length >= 2) {
        const [fullAst, topology] = results;
        const improvement = fullAst.totalTimeMs / topology.totalTimeMs;
        lines.push(`**Improvement:** ${improvement.toFixed(2)}x faster (LOD 1 vs LOD 3)`);
    }

    await fs.promises.writeFile(reportPath, lines.join('\n'), 'utf-8');
    console.log(`Report saved to ${reportPath}`);
}

function findTestFiles(dir: string, limit: number, found: string[] = []): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (found.length >= limit) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            findTestFiles(fullPath, limit, found);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
            found.push(fullPath);
        }
    }
    return found;
}

runBenchmark().catch(console.error);
