/**
 * ADR-042-005 v2 Editor Performance Benchmark Runner
 * 
 * Validates performance targets:
 * - Single edit resolution: < 300ms
 * - Batch edit resolution: < 2s
 * - Ambiguous match detection: < 200ms
 * - Cost guardrail checks: < 50ms
 */

import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EditResolver } from '../src/engine/EditResolver.js';
import { EditorEngine } from '../src/engine/Editor.js';
import { NodeFileSystem } from '../src/platform/FileSystem.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface EditRequest {
  oldCode: string;
  newCode: string;
  fuzzyMode?: "whitespace" | "levenshtein";
}

interface BenchmarkTarget {
  type: string;
  description: string;
  threshold_ms: number;
  file?: string;
  files?: string[];
  edits: Array<{ oldCode: string; newCode: string; fuzzyMode?: "whitespace" | "levenshtein" }>;
  expectedError?: string;
}

interface BenchmarkScenario {
  name: string;
  description: string;
  targets: BenchmarkTarget[];
  metrics: string[];
}

interface BenchmarkResult {
  target: string;
  description: string;
  duration_ms: number;
  threshold_ms: number;
  status: 'PASS' | 'FAIL' | 'SKIP';
  error?: string;
  details?: any;
}

async function runBenchmark(
  target: BenchmarkTarget,
  resolver: EditResolver,
  editor: EditorEngine,
  rootPath: string
): Promise<BenchmarkResult> {
  const startTime = performance.now();
  
  try {
    if (target.type === 'single-edit-resolve') {
      const filePath = path.join(rootPath, target.file!);
      const content = fs.readFileSync(filePath, 'utf-8');
      const edits = target.edits.map(e => ({
        targetString: e.oldCode,
        replacementString: e.newCode,
        fuzzyMode: e.fuzzyMode,
      }));
      
      const result = await resolver.resolveAll(filePath, edits);
      const duration = performance.now() - startTime;
      
      return {
        target: target.type,
        description: target.description,
        duration_ms: Math.round(duration * 100) / 100,
        threshold_ms: target.threshold_ms,
        status: duration < target.threshold_ms ? 'PASS' : 'FAIL',
        details: {
          resolved: result.resolvedEdits?.length || 0,
          errors: result.errors?.length || 0,
        },
      };
    }
    
    if (target.type === 'batch-edit-resolve') {
      const files = target.files!.map(f => path.join(rootPath, f));
      const results = [];
      
      for (const filePath of files) {
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const edits = target.edits.map(e => ({
          targetString: e.oldCode,
          replacementString: e.newCode,
          fuzzyMode: e.fuzzyMode,
        }));
        
        const result = await resolver.resolveAll(filePath, edits);
        results.push(result);
      }
      
      const duration = performance.now() - startTime;
      
      return {
        target: target.type,
        description: target.description,
        duration_ms: Math.round(duration * 100) / 100,
        threshold_ms: target.threshold_ms,
        status: duration < target.threshold_ms ? 'PASS' : 'FAIL',
        details: {
          filesProcessed: results.length,
          totalResolved: results.reduce((sum, r) => sum + (r.resolvedEdits?.length || 0), 0),
          totalErrors: results.reduce((sum, r) => sum + (r.errors?.length || 0), 0),
        },
      };
    }
    
    if (target.type === 'ambiguous-detection') {
      const filePath = path.join(rootPath, target.file!);
      const content = fs.readFileSync(filePath, 'utf-8');
      const edits = target.edits.map(e => ({
        targetString: e.oldCode,
        replacementString: e.newCode,
        fuzzyMode: e.fuzzyMode,
      }));
      
      const result = await resolver.resolveAll(filePath, edits, {
        allowAmbiguousAutoPick: false,
      });
      const duration = performance.now() - startTime;
      
      const hasExpectedError = result.errors?.some(e => e.errorCode === target.expectedError);
      
      return {
        target: target.type,
        description: target.description,
        duration_ms: Math.round(duration * 100) / 100,
        threshold_ms: target.threshold_ms,
        status: duration < target.threshold_ms && hasExpectedError ? 'PASS' : 'FAIL',
        details: {
          expectedError: target.expectedError,
          foundError: hasExpectedError,
          errorTypes: result.errors?.map(e => e.errorCode) || [],
        },
      };
    }
    
    if (target.type === 'cost-guardrail-levenshtein') {
      const filePath = path.join(rootPath, target.file!);
      const content = fs.readFileSync(filePath, 'utf-8');
      const edits = target.edits.map(e => ({
        targetString: e.oldCode,
        replacementString: e.newCode,
        fuzzyMode: e.fuzzyMode,
      }));
      
      const result = await resolver.resolveAll(filePath, edits);
      const duration = performance.now() - startTime;
      
      const hasExpectedError = result.errors?.some(e => e.errorCode === target.expectedError);
      
      return {
        target: target.type,
        description: target.description,
        duration_ms: Math.round(duration * 100) / 100,
        threshold_ms: target.threshold_ms,
        status: duration < target.threshold_ms && hasExpectedError ? 'PASS' : 'FAIL',
        details: {
          expectedError: target.expectedError,
          foundError: hasExpectedError,
          fileSize: content.length,
        },
      };
    }
    
    return {
      target: target.type,
      description: target.description,
      duration_ms: 0,
      threshold_ms: target.threshold_ms,
      status: 'SKIP',
      error: 'Unsupported benchmark type',
    };
  } catch (err) {
    const duration = performance.now() - startTime;
    return {
      target: target.type,
      description: target.description,
      duration_ms: Math.round(duration * 100) / 100,
      threshold_ms: target.threshold_ms,
      status: 'FAIL',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const distRoot = path.resolve(__dirname, '..');
  const rootPath = path.basename(distRoot) === 'dist'
    ? path.resolve(distRoot, '..')
    : distRoot;
  const scenarioPath = path.join(rootPath, 'benchmarks/scenarios/v2-editor.json');
  
  if (!fs.existsSync(scenarioPath)) {
    console.error(`Scenario not found: ${scenarioPath}`);
    process.exit(1);
  }
  
  const scenario: BenchmarkScenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'));
  
  console.log(`\n🚀 ${scenario.name}: ${scenario.description}\n`);
  
  const fileSystem = new NodeFileSystem(rootPath);
  const backupsDir = path.join(rootPath, '.backups');
  const editor = new EditorEngine(backupsDir, fileSystem);
  const resolver = new EditResolver(fileSystem, editor);
  
  const results: BenchmarkResult[] = [];
  
  for (const target of scenario.targets) {
    console.log(`\n📊 ${target.description}`);
    const result = await runBenchmark(target, resolver, editor, rootPath);
    results.push(result);
    
    const statusIcon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⏭️';
    console.log(`   ${statusIcon} ${result.duration_ms}ms / ${result.threshold_ms}ms`);
    
    if (result.details) {
      console.log(`   Details: ${JSON.stringify(result.details, null, 2)}`);
    }
    
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('BENCHMARK SUMMARY');
  console.log('='.repeat(60));
  
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  
  console.log(`\nTotal: ${results.length}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`⏭️  Skipped: ${skipped}`);
  
  if (failed > 0) {
    console.log('\n⚠️  Some benchmarks failed to meet performance targets');
    process.exit(1);
  } else {
    console.log('\n🎉 All benchmarks passed!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Benchmark runner error:', err);
  process.exit(1);
});
