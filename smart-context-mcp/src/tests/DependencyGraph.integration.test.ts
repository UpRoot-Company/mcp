import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { DependencyGraph } from '../ast/DependencyGraph.js';
import { IndexDatabase } from '../indexing/IndexDatabase.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { ModuleResolver } from '../ast/ModuleResolver.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


describe('DependencyGraph with AST extraction', () => {
  let testDir: string;
  let database: IndexDatabase;
  let symbolIndex: SymbolIndex;
  let moduleResolver: ModuleResolver;
  let depGraph: DependencyGraph;
  
  beforeEach(async () => {
    testDir = path.join(__dirname, 'fixtures', 'depgraph-test-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    
    // Initialize required dependencies
    database = new IndexDatabase(path.join(testDir, 'test-index.db'));
    symbolIndex = new SymbolIndex(testDir, new SkeletonGenerator(), [], database);
    moduleResolver = new ModuleResolver(testDir);
    depGraph = new DependencyGraph(testDir, symbolIndex, moduleResolver, database);


  });
  
  afterEach(async () => {

    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('should extract edges from file with imports', async () => {
    // Create test files
    const moduleA = path.join(testDir, 'a.ts');
    const moduleB = path.join(testDir, 'b.ts');
    
    await fs.writeFile(moduleA, 'export const a = 1;');
    await fs.writeFile(moduleB, `import { a } from './a';\nexport const b = a + 1;`);
    
    // Update dependencies
    await depGraph.updateFileDependencies(moduleB);
    
    // Get dependencies
    const edges = await depGraph.getDependencies(moduleB, 'downstream');
    
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe(moduleA); // Should be the absolute path
  });
  
  test('should support reverse dependency lookup (who imports this file)', async () => {
    const moduleA = path.join(testDir, 'a.ts');
    const moduleB = path.join(testDir, 'b.ts');
    const moduleC = path.join(testDir, 'c.ts');
    
    await fs.writeFile(moduleA, 'export const a = 1;');
    await fs.writeFile(moduleB, `import { a } from './a';`);
    await fs.writeFile(moduleC, `import { a } from './a';`);
    
    // Update both importers
    await depGraph.updateFileDependencies(moduleB);
    await depGraph.updateFileDependencies(moduleC);
    
    // Query: who imports moduleA?
    const importers = await depGraph.getImporters(moduleA);
    
    expect(importers).toHaveLength(2);
    const importerPaths = importers.map(e => e.from);
    expect(importerPaths).toContain(moduleB);
    expect(importerPaths).toContain(moduleC);
  });
  
  test('should match the exact user scenario', async () => {
    // Recreate user's file structure
    const particlePath = path.join(testDir, 'particle.ts');
    const indexPath = path.join(testDir, 'index.ts');
    const irPath = path.join(testDir, 'ir.ts');
    const samplePath = path.join(testDir, 'sample.ts');
    const basePath = path.join(testDir, 'base-particle.ts');
    
    await fs.writeFile(indexPath, 'export type Option = {};');
    await fs.writeFile(irPath, 'export function calculateIRs() {}; export type IR = {};');
    await fs.writeFile(samplePath, 'export type Sample = {};');
    await fs.writeFile(basePath, 'export class Particle {}');
    await fs.writeFile(particlePath, `
import type { Option } from './index';
import { calculateIRs, type IR } from './ir';
import type { Sample } from './sample';
import { Particle as BaseParticle } from './base-particle';

export class QuantumParticle extends BaseParticle {}\n    `);
    
    // Update dependencies
    await depGraph.updateFileDependencies(particlePath);
    
    // Get edges
    const edges = await depGraph.getDependencies(particlePath, 'downstream'); // Should get outgoing dependencies
    
    // Should now have 4 edges (not empty!)
    expect(edges.length).toBeGreaterThanOrEqual(4);
    
    const targets = edges.map(e => e.to);
    expect(targets).toContain(indexPath);
    expect(targets).toContain(irPath);
    expect(targets).toContain(samplePath);
    expect(targets).toContain(basePath);
  });
});