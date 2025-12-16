import { describe, test, expect, beforeEach } from '@jest/globals';
import { ImportExtractor } from '../ast/ImportExtractor.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('ImportExtractor', () => {
  let extractor: ImportExtractor;
  let testDir: string;
  
  beforeEach(async () => {
    testDir = path.join(__dirname, 'fixtures', 'import-test-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    extractor = new ImportExtractor(testDir);
  });
  
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('should extract named imports', async () => {
    const filePath = path.join(testDir, 'test.ts');
    await fs.writeFile(filePath, `
import { foo, bar as baz } from './module';
    `);
    // Create dummy module to resolve
    await fs.writeFile(path.join(testDir, 'module.ts'), 'export const foo = 1; export const bar = 2;');
    
    const imports = await extractor.extractImports(filePath);
    
    expect(imports).toHaveLength(1);
    expect(imports[0].what).toEqual(['foo', 'baz']);
    expect(imports[0].importType).toBe('named');
  });
  
  test('should extract default import', async () => {
    const filePath = path.join(testDir, 'test.ts');
    await fs.writeFile(filePath, `
import Foo from './module';
    `);
    await fs.writeFile(path.join(testDir, 'module.ts'), 'export default class Foo {}');

    const imports = await extractor.extractImports(filePath);
    
    expect(imports).toHaveLength(1);
    expect(imports[0].what).toEqual(['Foo']);
    expect(imports[0].importType).toBe('default');
  });
  
  test('should extract namespace import', async () => {
    const filePath = path.join(testDir, 'test.ts');
    await fs.writeFile(filePath, `
import * as utils from './utils';
    `);
    await fs.writeFile(path.join(testDir, 'utils.ts'), 'export const a = 1;');

    const imports = await extractor.extractImports(filePath);
    
    expect(imports).toHaveLength(1);
    expect(imports[0].what).toEqual(['*']);
    expect(imports[0].importType).toBe('namespace');
  });
  
  test('should extract side-effect import', async () => {
    const filePath = path.join(testDir, 'test.ts');
    await fs.writeFile(filePath, `
import './polyfill';
    `);
    await fs.writeFile(path.join(testDir, 'polyfill.ts'), 'console.log("loaded");');

    const imports = await extractor.extractImports(filePath);
    
    expect(imports).toHaveLength(1);
    expect(imports[0].what).toEqual([]);
    expect(imports[0].importType).toBe('side-effect');
  });
  
  test('should extract type-only imports', async () => {
    const filePath = path.join(testDir, 'test.ts');
    await fs.writeFile(filePath, `
import type { Option } from './types';
import { type IR, calculateIRs } from './utils';
    `);
    await fs.writeFile(path.join(testDir, 'types.ts'), 'export type Option = any;');
    await fs.writeFile(path.join(testDir, 'utils.ts'), 'export type IR = any; export function calculateIRs() {}');

    const imports = await extractor.extractImports(filePath);
    
    expect(imports).toHaveLength(2);
    
    // Expect Option
    const optionImport = imports.find(i => i.what.includes('Option'));
    expect(optionImport).toBeDefined();
    
    // Expect IR, calculateIRs
    const utilsImport = imports.find(i => i.what.includes('calculateIRs'));
    expect(utilsImport).toBeDefined();
    expect(utilsImport?.what).toContain('IR');
    expect(utilsImport?.what).toContain('calculateIRs');
  });
  
  test('should extract CommonJS require', async () => {
    const filePath = path.join(testDir, 'test.js');
    await fs.writeFile(filePath, `
const foo = require('./module');
const { bar, baz } = require('./utils');
    `);
    await fs.writeFile(path.join(testDir, 'module.js'), 'module.exports = {};');
    await fs.writeFile(path.join(testDir, 'utils.js'), 'module.exports = {bar:1, baz:2};');

    const imports = await extractor.extractImports(filePath);
    
    expect(imports).toHaveLength(2);
    const fooImport = imports.find(i => i.what.includes('foo'));
    const utilsImport = imports.find(i => i.what.includes('bar'));
    
    expect(fooImport).toBeDefined();
    expect(utilsImport).toBeDefined();
    expect(utilsImport?.what).toContain('baz');
  });

  test('should handle the exact user scenario (particle.ts)', async () => {
    // Create dummy files for module resolution
    await fs.writeFile(path.join(testDir, 'index.ts'), 'export type Option = {};');
    await fs.writeFile(path.join(testDir, 'ir.ts'), 'export function calculateIRs() {}; export type IR = {};');
    await fs.writeFile(path.join(testDir, 'sample.ts'), 'export type Sample = {};');
    await fs.writeFile(path.join(testDir, 'base-particle.ts'), 'export class Particle {}');

    const filePath = path.join(testDir, 'particle.ts');
    await fs.writeFile(filePath, `
import type { Option } from './index';
import { calculateIRs, type IR } from './ir';
import type { Sample } from './sample';
import { Particle as BaseParticle } from './base-particle';

export class QuantumParticle extends BaseParticle {\n  // ...\n}\n    `);
    
    const imports = await extractor.extractImports(filePath);
    
    // Should find all 4 imports!
    expect(imports).toHaveLength(4);
    
    expect(imports[0].what).toEqual(['Option']);
    expect(imports[1].what).toEqual(['IR', 'calculateIRs']);
    expect(imports[2].what).toEqual(['Sample']);
    expect(imports[3].what).toEqual(['BaseParticle']);
  });
});
