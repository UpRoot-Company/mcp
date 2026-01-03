import { AstManager } from '../src/ast/AstManager';
import { FeatureFlags } from '../src/config/FeatureFlags';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

async function runBenchmark() {
    FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
    FeatureFlags.set(FeatureFlags.TOPOLOGY_SCANNER_ENABLED, true);
    
    console.log('============================================================');
    console.log('LOD Performance Comparison Benchmark (ADR-043 Final)');
    console.log('============================================================');

    const testFiles = findTestFiles('src', 50);
    console.log(`Found ${testFiles.length} test files\n`);

    // Scenario 1: Full AST (LOD 3)
    console.log('Scenario 1: Full AST (LOD 3) - Baseline...');
    const manager1 = AstManager.getInstance();
    const start3 = performance.now();
    for (const file of testFiles) {
        try {
            await manager1.ensureLOD({ path: file, minLOD: 3 });
        } catch (e) {
            console.error(`  - Failed LOD 3 for ${file}:`, e instanceof Error ? e.message : e);
        }
    }
    const end3 = performance.now();
    const time3 = end3 - start3;

    // Scenario 2: Topology Scan (LOD 1)
    console.log('Scenario 2: Topology Scan (LOD 1) - Optimized...');
    await AstManager.resetForTestingAsync();
    const manager2 = AstManager.getInstance();
    const start1 = performance.now();
    for (const file of testFiles) {
        try {
            await manager2.ensureLOD({ path: file, minLOD: 1 });
        } catch (e) {
            console.error(`  - Failed LOD 1 for ${file}:`, e instanceof Error ? e.message : e);
        }
    }
    const end1 = performance.now();
    const time1 = end1 - start1;

    console.log('\n============================================================');
    console.log('RESULTS:');
    console.log('------------------------------------------------------------');
    console.log(`Full AST (LOD 3): Total ${time3.toFixed(2)}ms, Avg ${(time3 / testFiles.length).toFixed(2)}ms/file`);
    console.log(`Topology (LOD 1): Total ${time1.toFixed(2)}ms, Avg ${(time1 / testFiles.length).toFixed(2)}ms/file`);
    console.log('------------------------------------------------------------');
    console.log(`Improvement: ${((time3) / (time1)).toFixed(2)}x faster`);
    console.log('============================================================');
    
    await AstManager.resetForTestingAsync();
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
