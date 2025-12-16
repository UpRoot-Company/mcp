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
    
    // Resolve to absolute path
    // Corrected argument order: resolve(contextPath, importPath)
    const resolvedPath = this.moduleResolver.resolve(contextPath, moduleSpecifier);
    if (!resolvedPath) {
      // console.warn(`[ImportExtractor] Could not resolve: ${moduleSpecifier} from ${contextPath}`);
      return null;
    }
    
    // Get line number
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    
    // Extract imported names
    const importClause = node.importClause;
    if (!importClause) {
      // Side-effect import: import './foo'
      return {
        from: resolvedPath,
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
        for (const element of importClause.namedBindings.elements) {
          what.push(element.name.text);
        }
        if (importType !== 'default') {
          importType = 'named';
        }
      }
    }
    
    return {
      from: resolvedPath,
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
    if (!resolvedPath) return null;
    
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    
    return {
      from: resolvedPath,
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
          if (!resolvedPath) continue;
          
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
            from: resolvedPath,
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
          const moduleSpecifier = node.source.value;
          const resolvedPath = this.moduleResolver.resolve(filePath, moduleSpecifier);
          if (!resolvedPath) return;
          
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
            from: resolvedPath,
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
            if (!resolvedPath) return;
            
            // Try to extract variable name from parent
            const what: string[] = [];
            const parent = path.parent;
            
            if (t.isVariableDeclarator(parent) &&
                t.isIdentifier(parent.id)) {
              what.push(parent.id.name);
            }
            
            imports.push({
              from: resolvedPath,
              what,
              line: node.loc?.start.line || 0,
              importType: 'default'
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
