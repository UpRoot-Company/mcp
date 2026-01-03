#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { AstManager } from '../src/ast/AstManager.js';
import { FeatureFlags } from '../src/config/FeatureFlags.js';

interface BenchmarkResult {
    scenario: string;
    files: number;
    totalTimeMs: number;
    avgTimePerFileMs: number;
    memoryUsedMB: number;
}

/**
 * Benchmark: Compare LOD 1 extraction vs Full AST parsing
 * Run: npm run benchmark:lod
 */
async function main() {
    console.log('='.repeat(60));
    console.log('LOD Performance Comparison Benchmark');
    console.log('='.repeat(60));
    
    const testFiles = findTestFiles(process.cwd(), 50); // Sample 50 files
    console.log(`\nFound ${testFiles.length} test files\n`);
    
    const results: BenchmarkResult[] = [];
    
    // Scenario 1: Full AST (current behavior)
    console.log('Scenario 1: Full AST Parsing (baseline)...');
    FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
    results.push(await benchmarkFullAST(testFiles));
    
    // Scenario 2: LOD 1 with TopologyScanner (Phase 2 - placeholder)
    console.log('\nScenario 2: LOD 1 Topology Scan (not yet implemented)...');
    console.log('  → Will be implemented in Phase 2');
    
    // Print results
    console.log('\n' + '='.repeat(60));
    console.log('RESULTS');
    console.log('='.repeat(60));
    
    results.forEach(r => {
        console.log(`\n${r.scenario}:`);
        console.log(`  Files:            ${r.files}`);
        console.log(`  Total Time:       ${r.totalTimeMs.toFixed(2)}ms`);
        console.log(`  Avg Time/File:    ${r.avgTimePerFileMs.toFixed(2)}ms`);
        console.log(`  Memory Used:      ${r.memoryUsedMB.toFixed(2)}MB`);
    });
    
    console.log('\n' + '='.repeat(60));

    // Cleanup to allow process to exit
    const manager = AstManager.getInstance();
    await manager.dispose();
    process.exit(0);
}

async function benchmarkFullAST(files: string[]): Promise<BenchmarkResult> {
    const manager = AstManager.getInstance();
    await manager.init({ mode: 'prod', rootPath: process.cwd() });
    
    const memBefore = process.memoryUsage().heapUsed;
    const startTime = performance.now();
    
    for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        await manager.parseFile(file, content);
    }
    
    const totalTimeMs = performance.now() - startTime;
    const memAfter = process.memoryUsage().heapUsed;
    const memoryUsedMB = (memAfter - memBefore) / 1024 / 1024;
    
    return {
        scenario: 'Full AST Parsing',
        files: files.length,
        totalTimeMs,
        avgTimePerFileMs: totalTimeMs / files.length,
        memoryUsedMB
    };
}

function findTestFiles(dir: string, maxFiles: number): string[] {
    const files: string[] = [];
    const srcDir = path.join(dir, 'src');
    
    function walk(currentDir: string) {
        if (files.length >= maxFiles) return;
        
        if (!fs.existsSync(currentDir)) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (files.length >= maxFiles) break;
            
            const fullPath = path.join(currentDir, entry.name);
            
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
                files.push(fullPath);
            }
        }
    }
    
    walk(srcDir);
    return files.slice(0, maxFiles);
}

main().catch(console.error);
