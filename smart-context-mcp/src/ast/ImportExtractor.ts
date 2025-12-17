import * as ts from 'typescript';
import * as babel from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as fs from 'fs';
import * as path from 'path';
import type { ImportInfo } from '../indexing/ProjectIndex.js';
import { ModuleResolver } from './ModuleResolver.js';

/**
 * Extracts import declarations from TypeScript/JavaScript files using AST parsing
 */
export class ImportExtractor {
  private moduleResolver: ModuleResolver;
  
  constructor(projectRoot: string) {
    this.moduleResolver = new ModuleResolver(projectRoot);
  }
  
  /**
   * Extract all imports from a file
   * Automatically detects TypeScript vs JavaScript
   */
  async extractImports(filePath: string): Promise<ImportInfo[]> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      return [];
    }

    const source = await fs.promises.readFile(filePath, 'utf-8');
    const isTypeScript = this.isTypeScriptFile(filePath);
    
    if (isTypeScript) {
      return this.extractTypeScriptImports(source, filePath);
    } else {
      return this.extractJavaScriptImports(source, filePath);
    }
  }
  
  /**
   * Extract imports from TypeScript using TypeScript Compiler API
   */
  private extractTypeScriptImports(source: string, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    
    // Parse TypeScript source to AST
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true, // setParentNodes
      this.getScriptKind(filePath)
    );
    
    // Traverse AST and find import declarations
    const visit = (node: ts.Node) => {
      // Handle: import { foo, bar } from './module'
      if (ts.isImportDeclaration(node)) {
        const importInfo = this.parseImportDeclaration(node, sourceFile, filePath);
        if (importInfo) {
          imports.push(importInfo);
        }
      }
      
      // Handle: import foo = require('./module') (TypeScript-specific)
      if (ts.isImportEqualsDeclaration(node)) {
        const importInfo = this.parseImportEquals(node, sourceFile, filePath);
        if (importInfo) {
          imports.push(importInfo);
        }
      }
      
      // Handle: const foo = require('./module') (CommonJS)
      if (ts.isVariableStatement(node)) {
        const requireImports = this.extractRequireFromVariableStatement(node, sourceFile, filePath);
        imports.push(...requireImports);
      }
      
      ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);
    return imports;
  }
  
  /**
   * Parse TypeScript import declaration
   * Handles: import { a, b as c } from './foo'
   *          import * as foo from './bar'
   *          import foo from './baz'
   *          import './side-effect'
   */
  private parseImportDeclaration(
    node: ts.ImportDeclaration,
    sourceFile: ts.SourceFile,
    contextPath: string
  ): ImportInfo | null {
    // Get module specifier (e.g., './foo', 'lodash')
    const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
    
    // Resolve to absolute path (may be undefined if module not found)
    const resolvedPath = this.moduleResolver.resolve(contextPath, moduleSpecifier);
    
    // Get line number
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    
    // Extract imported names
    const importClause = node.importClause;
    if (!importClause) {
      // Side-effect import: import './foo'
      return {
        specifier: moduleSpecifier,
        resolvedPath: resolvedPath ?? undefined,
        what: [],
        line: line + 1,
        importType: 'side-effect'
      };
    }
    
    const what: string[] = [];
    let importType: ImportInfo['importType'] = 'named';
    
    // Default import: import Foo from './foo'
    if (importClause.name) {
      what.push(importClause.name.text);
      importType = 'default';
    }
    
    // Named bindings: import { a, b } from './foo' OR import * as foo from './foo'
    if (importClause.namedBindings) {
      if (ts.isNamespaceImport(importClause.namedBindings)) {
        // Namespace import: import * as foo from './bar'
        what.push('*');
        importType = 'namespace';
      } else if (ts.isNamedImports(importClause.namedBindings)) {
        // Named imports: import { a, b as c } from './foo'
        const typeOnlyBindings: string[] = [];
        const valueBindings: string[] = [];
        for (const element of importClause.namedBindings.elements) {
          const targetBucket = (importClause.isTypeOnly || element.isTypeOnly)
            ? typeOnlyBindings
            : valueBindings;
          targetBucket.push(element.name.text);
        }
        what.push(...typeOnlyBindings, ...valueBindings);
        if (importType !== 'default') {
          importType = 'named';
        }
      }
    }
    
    return {
      specifier: moduleSpecifier,
      resolvedPath: resolvedPath ?? undefined,
      what,
      line: line + 1,
      importType
    };
  }
  
  /**
   * Parse TypeScript import equals declaration
   * Handles: import foo = require('./module')
   */
  private parseImportEquals(
    node: ts.ImportEqualsDeclaration,
    sourceFile: ts.SourceFile,
    contextPath: string
  ): ImportInfo | null {
    if (!ts.isExternalModuleReference(node.moduleReference)) {
      return null; // Not a module import
    }
    
    const expr = node.moduleReference.expression;
    if (!ts.isStringLiteral(expr)) {
      return null;
    }
    
    const moduleSpecifier = expr.text;
    const resolvedPath = this.moduleResolver.resolve(contextPath, moduleSpecifier);
    
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    
    return {
      specifier: moduleSpecifier,
      resolvedPath: resolvedPath ?? undefined,
      what: [node.name.text],
      line: line + 1,
      importType: 'default'
    };
  }
  
  /**
   * Extract require() calls from variable statements
   * Handles: const foo = require('./module')
   *          const { a, b } = require('./module')
   */
  private extractRequireFromVariableStatement(
    node: ts.VariableStatement,
    sourceFile: ts.SourceFile,
    contextPath: string
  ): ImportInfo[] {
    const imports: ImportInfo[] = [];
    
    for (const declaration of node.declarationList.declarations) {
      if (!declaration.initializer) continue;
      
      // Check if initializer is require() call
      if (ts.isCallExpression(declaration.initializer)) {
        const callExpr = declaration.initializer;
        if (callExpr.expression.getText(sourceFile) === 'require' &&
            callExpr.arguments.length === 1 &&
            ts.isStringLiteral(callExpr.arguments[0])) {
          
          const moduleSpecifier = (callExpr.arguments[0] as ts.StringLiteral).text;
          const resolvedPath = this.moduleResolver.resolve(contextPath, moduleSpecifier);
          
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          
          // Extract imported names from destructuring
          const what: string[] = [];
          if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (ts.isIdentifier(element.name)) {
                what.push(element.name.text);
              }
            }
          } else if (ts.isIdentifier(declaration.name)) {
            what.push(declaration.name.text);
          }
          
          imports.push({
            specifier: moduleSpecifier,
            resolvedPath: resolvedPath ?? undefined,
            what,
            line: line + 1,
            importType: what.length > 1 ? 'named' : 'default'
          });
        }
      }
    }
    
    return imports;
  }
  
  /**
   * Extract imports from JavaScript using Babel
   */
  private extractJavaScriptImports(source: string, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = [];

    const appendBindingNames = (binding: t.Node | null | undefined, bucket: string[]): void => {
      if (!binding) return;
      if (t.isIdentifier(binding)) {
        bucket.push(binding.name);
        return;
      }
      if (t.isObjectPattern(binding)) {
        for (const prop of binding.properties) {
          if (t.isObjectProperty(prop)) {
            const value = prop.value;
            if (t.isIdentifier(value)) {
              bucket.push(value.name);
            } else if (t.isAssignmentPattern(value) && t.isIdentifier(value.left)) {
              bucket.push(value.left.name);
            }
          } else if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
            bucket.push(prop.argument.name);
          }
        }
        return;
      }
      if (t.isArrayPattern(binding)) {
        for (const element of binding.elements) {
          if (!element) continue;
          if (t.isIdentifier(element)) {
            bucket.push(element.name);
          } else if (t.isRestElement(element) && t.isIdentifier(element.argument)) {
            bucket.push(element.argument.name);
          } else if (t.isAssignmentPattern(element) && t.isIdentifier(element.left)) {
            bucket.push(element.left.name);
          }
        }
        return;
      }
      if (t.isAssignmentPattern(binding) && t.isIdentifier(binding.left)) {
        bucket.push(binding.left.name);
        return;
      }
      if (t.isRestElement(binding) && t.isIdentifier(binding.argument)) {
        bucket.push(binding.argument.name);
      }
    };
    
    try {
      // Parse JavaScript/JSX with Babel
      const ast = babel.parse(source, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'], // Support JSX and TS in .js files
        sourceFilename: filePath
      });
      
      // Traverse AST
      // @ts-ignore
      const traverseFn = traverse.default || traverse;
      traverseFn(ast, {
        // Handle ES6 imports
        ImportDeclaration: (path: any) => {
          const node = path.node;
          const moduleSpecifier = node.source.value as string;
          const resolvedPath = this.moduleResolver.resolve(filePath, moduleSpecifier);
          
          const what: string[] = [];
          let importType: ImportInfo['importType'] = 'named';
          
          for (const specifier of node.specifiers) {
            if (t.isImportDefaultSpecifier(specifier)) {
              what.push(specifier.local.name);
              importType = 'default';
            } else if (t.isImportNamespaceSpecifier(specifier)) {
              what.push('*');
              importType = 'namespace';
            } else if (t.isImportSpecifier(specifier)) {
              // @ts-ignore
              what.push(specifier.imported.name || specifier.imported.value);
            }
          }
          
          imports.push({
            specifier: moduleSpecifier,
            resolvedPath: resolvedPath ?? undefined,
            what,
            line: node.loc?.start.line || 0,
            importType
          });
        },
        
        // Handle require() calls
        CallExpression: (path: any) => {
          const node = path.node;
          if (t.isIdentifier(node.callee) &&
              node.callee.name === 'require' &&
              node.arguments.length === 1 &&
              t.isStringLiteral(node.arguments[0])) {
            
            const moduleSpecifier = node.arguments[0].value;
            const resolvedPath = this.moduleResolver.resolve(filePath, moduleSpecifier);
            
            // Try to extract variable name(s) from parent
            const what: string[] = [];
            const parentNode = path.parentPath?.node ?? path.parent;
            if (t.isVariableDeclarator(parentNode)) {
              appendBindingNames(parentNode.id, what);
            }
            
            const isDestructured = t.isVariableDeclarator(parentNode) && !t.isIdentifier(parentNode.id);
            const importType: ImportInfo['importType'] = (isDestructured || what.length > 1) ? 'named' : 'default';
            
            imports.push({
              specifier: moduleSpecifier,
              resolvedPath: resolvedPath ?? undefined,
              what,
              line: node.loc?.start.line || 0,
              importType
            });
          }
        }
      });
      
    } catch (error) {
      console.error(`[ImportExtractor] Error parsing ${filePath}:`, error);
    }
    
    return imports;
  }
  
  /**
   * Check if file is TypeScript
   */
  private isTypeScriptFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.ts' || ext === '.tsx';
  }
  
  /**
   * Get TypeScript ScriptKind based on file extension
   */
  private getScriptKind(filePath: string): ts.ScriptKind {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.ts': return ts.ScriptKind.TS;
      case '.tsx': return ts.ScriptKind.TSX;
      case '.jsx': return ts.ScriptKind.JSX;
      default: return ts.ScriptKind.JS;
    }
  }
}
