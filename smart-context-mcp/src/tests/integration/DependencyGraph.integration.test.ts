import { describe, test, expect, beforeEach } from '@jest/globals';
import { DependencyGraph } from '../../ast/DependencyGraph.js';
import { IndexDatabase } from '../../indexing/IndexDatabase.js';
import { SymbolIndex } from '../../ast/SymbolIndex.js';
import { ModuleResolver } from '../../ast/ModuleResolver.js';
import { SkeletonGenerator } from '../../ast/SkeletonGenerator.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('DependencyGraph with AST extraction', () => {
  let testDir: string;
  let database: IndexDatabase;
  let depGraph: DependencyGraph;
  let resolver: ModuleResolver;
  let symbolIndex: SymbolIndex;
  
  beforeEach(async () => {
    testDir = path.join(__dirname, 'fixtures', 'depgraph-test-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    
    database = new IndexDatabase(testDir);
    resolver = new ModuleResolver(testDir);
    symbolIndex = new SymbolIndex(testDir, new SkeletonGenerator(), [], database);
    
    depGraph = new DependencyGraph(testDir, symbolIndex, resolver, database);
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
    expect(edges[0].to.replace(/\\/g, '/')).toBe(moduleA.replace(/\\/g, '/'));
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
    const importers = await depGraph.getDependencies(moduleA, 'upstream');
    
    expect(importers).toHaveLength(2);
    const normalizedImporters = importers.map(p => p.from.replace(/\\/g, '/'));
    expect(normalizedImporters).toContain(moduleB.replace(/\\/g, '/'));
    expect(normalizedImporters).toContain(moduleC.replace(/\\/g, '/'));
  });
  
  test('should match the exact user scenario', async () => {
    // Setup dirs
    const deepDir = path.join(testDir, 'dir1', 'dir2');
    await fs.mkdir(deepDir, { recursive: true });
    await fs.mkdir(path.join(testDir, 'helpers', 'processing'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'dir1', 'base'), { recursive: true });
    
    const targetParticle = path.join(deepDir, 'particle.ts');
    const targetIndex = path.join(deepDir, 'index.ts');
    const irFile = path.join(testDir, 'helpers', 'processing', 'ir.ts');
    const sampleFile = path.join(testDir, 'helpers', 'processing', 'sample.ts');
    const baseParticleFile = path.join(testDir, 'dir1', 'base', 'particle.ts');
    
    await fs.writeFile(targetIndex, 'export type Option = {};');
    await fs.writeFile(irFile, 'export function calculateIRs() {}; export type IR = {};');
    await fs.writeFile(sampleFile, 'export type Sample = {};');
    await fs.writeFile(baseParticleFile, 'export class Particle {}');
    
    await fs.writeFile(targetParticle, `
import type { Option } from './index';
import { calculateIRs, type IR } from '../../helpers/processing/ir';
import type { Sample } from '../../helpers/processing/sample';
import { Particle as BaseParticle } from '../base/particle';

export class QuantumParticle extends BaseParticle {}
    `);
    
    // Update dependencies
    await depGraph.updateFileDependencies(targetParticle);
    
    // Get edges
    const edges = await depGraph.getDependencies(targetParticle, 'downstream');
    
    // Should now have 4 edges (not empty!)
    expect(edges.length).toBeGreaterThanOrEqual(4);
    
    const normalizedEdges = edges.map(p => p.to.replace(/\\/g, '/'));
    expect(normalizedEdges).toContain(targetIndex.replace(/\\/g, '/'));
    expect(normalizedEdges).toContain(irFile.replace(/\\/g, '/'));
    expect(normalizedEdges).toContain(sampleFile.replace(/\\/g, '/'));
    expect(normalizedEdges).toContain(baseParticleFile.replace(/\\/g, '/'));
  });
});
