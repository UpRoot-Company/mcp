import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import type { ExportInfo } from '../indexing/ProjectIndex.js';
import { ModuleResolver } from './ModuleResolver.js';

/**
 * Extracts export declarations from TypeScript/JavaScript files
 */
export class ExportExtractor {
  private moduleResolver: ModuleResolver;
  
  constructor(projectRoot: string) {
    this.moduleResolver = new ModuleResolver(projectRoot);
  }
  
  /**
   * Extract all exports from a file
   */
  async extractExports(filePath: string): Promise<ExportInfo[]> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      return [];
    }

    const source = await fs.promises.readFile(filePath, 'utf-8');
    return this.extractTypeScriptExports(source, filePath);
  }
  
  /**
   * Extract exports using TypeScript Compiler API
   */
  private extractTypeScriptExports(source: string, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = [];
    
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true
    );
    
    const visit = (node: ts.Node) => {
      // Handle: export class Foo {}
      //         export function bar() {}
      //         export const baz = 1;
      if ((ts.isFunctionDeclaration(node) ||
           ts.isClassDeclaration(node) ||
           ts.isVariableStatement(node)) &&
          node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
          if (node.name) {
            const isDefault = node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
            exports.push({
              name: node.name.text,
              exportType: isDefault ? 'default' : 'named',
              line: line + 1,
              isReExport: false
            });
          }
        } else if (ts.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              exports.push({
                name: declaration.name.text,
                exportType: 'named',
                line: line + 1,
                isReExport: false
              });
            }
          }
        }
      }
      
      // Handle: export { foo, bar as baz }
      //         export { foo } from './module'
      if (ts.isExportDeclaration(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        // Check if re-export
        const isReExport = !!node.moduleSpecifier;
        const reExportFrom = isReExport && ts.isStringLiteral(node.moduleSpecifier)
          ? this.moduleResolver.resolve(filePath, node.moduleSpecifier.text)
          : undefined;
        
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            exports.push({
              name: element.name.text,
              exportType: 'named',
              line: line + 1,
              isReExport,
              reExportFrom: reExportFrom || undefined
            });
          }
        } else if (!node.exportClause && isReExport) {
          // export * from './module'
          exports.push({
            name: '*',
            exportType: 'named',
            line: line + 1,
            isReExport: true,
            reExportFrom: reExportFrom || undefined
          });
        }
      }
      
      // Handle: export default Foo;
      if (ts.isExportAssignment(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const name = node.expression.getText(sourceFile);
        
        exports.push({
          name,
          exportType: 'default',
          line: line + 1,
          isReExport: false
        });
      }
      
      ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);
    return exports;
  }
}
