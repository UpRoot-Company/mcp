/**
 * ADR-042-006: Phase 3 - TemplateGenerator (Mustache-like Engine)
 * 
 * Extends SimpleTemplateGenerator with advanced template features:
 * - Variable substitution with conditionals
 * - Pattern-based template selection
 * - Integration with PatternExtractor results
 */

import { SimpleTemplateGenerator, type TemplateContext } from './SimpleTemplateGenerator.js';
import type { CodeStyle } from './StyleInference.js';
import type { ProjectPatterns, ImportPattern, NamingPattern } from './PatternExtractor.js';

/**
 * Template variables for Mustache-like substitution
 */
export interface TemplateVariables {
    [key: string]: string | number | boolean | undefined | TemplateVariables | TemplateVariables[] | any[];
}

/**
 * Advanced template context with patterns
 */
export interface AdvancedTemplateContext extends TemplateContext {
    /** Variables for template substitution */
    variables?: TemplateVariables;
    /** Project patterns for intelligent generation */
    patterns?: ProjectPatterns;
    /** Use pattern-based generation */
    usePatterns?: boolean;
}

/**
 * Template compilation result
 */
interface CompiledTemplate {
    /** Rendered template string */
    code: string;
    /** Imports that should be added */
    imports: string[];
}

/**
 * TemplateGenerator - Phase 3 Full Code Generation
 * 
 * Advanced code generator with Mustache-like template engine:
 * - {{variable}} - Simple variable substitution
 * - {{#condition}}...{{/condition}} - Conditional blocks
 * - {{^condition}}...{{/condition}} - Inverted conditionals
 * - {{#array}}...{{/array}} - Array iteration
 * 
 * Uses PatternExtractor results to generate code matching project style.
 */
export class TemplateGenerator extends SimpleTemplateGenerator {
    constructor(style: CodeStyle) {
        super(style);
    }

    /**
     * Generate code with advanced template features
     * 
     * @param type Template type (function, class, interface)
     * @param context Template context with variables and patterns
     * @returns Generated code with imports
     */
    public generateAdvanced(
        type: 'function' | 'class' | 'interface',
        context: AdvancedTemplateContext
    ): CompiledTemplate {
        if (context.usePatterns && context.patterns) {
            return this.generateWithPatterns(type, context);
        }

        // Fall back to simple generation with variable substitution
        const code = this.generate(type, context);
        return {
            code: context.variables ? this.renderTemplate(code, context.variables) : code,
            imports: [],
        };
    }

    /**
     * Generate code using project patterns
     */
    private generateWithPatterns(
        type: 'function' | 'class' | 'interface',
        context: AdvancedTemplateContext
    ): CompiledTemplate {
        const patterns = context.patterns!;
        const imports: string[] = [];

        // Apply naming conventions from patterns
        const naming = this.findNamingPattern(type, patterns.naming);
        const adjustedContext = this.applyNamingConvention(context, naming);

        // Generate base code
        let code = this.generate(type, adjustedContext);

        // Apply variable substitution if provided
        if (context.variables) {
            code = this.renderTemplate(code, context.variables);
        }

        // Add common imports based on patterns
        if (type === 'class' && patterns.imports.length > 0) {
            const commonImports = this.extractCommonImports(patterns.imports);
            imports.push(...commonImports);
        }

        return { code, imports };
    }

    /**
     * Find naming pattern for symbol type
     */
    private findNamingPattern(
        type: 'function' | 'class' | 'interface',
        namingPatterns: NamingPattern[]
    ): NamingPattern | undefined {
        return namingPatterns.find(p => p.type === type);
    }

    /**
     * Apply naming convention to context
     */
    private applyNamingConvention(
        context: AdvancedTemplateContext,
        naming?: NamingPattern
    ): AdvancedTemplateContext {
        if (!naming || !context.name) {
            return context;
        }

        // Convert name to match project convention
        const convertedName = this.convertNamingConvention(context.name, naming.convention);

        return {
            ...context,
            name: convertedName,
        };
    }

    /**
     * Convert name to target naming convention
     */
    private convertNamingConvention(
        name: string,
        convention: 'camelCase' | 'PascalCase' | 'UPPER_CASE' | 'kebab-case' | 'snake_case'
    ): string {
        // Split name into words (handle camelCase, PascalCase, snake_case, kebab-case)
        const words = name
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[_-]/g, ' ')
            .split(' ')
            .map(w => w.toLowerCase());

        switch (convention) {
            case 'camelCase':
                return words[0] + words.slice(1).map(this.capitalize).join('');
            case 'PascalCase':
                return words.map(this.capitalize).join('');
            case 'UPPER_CASE':
                return words.join('_').toUpperCase();
            case 'snake_case':
                return words.join('_');
            case 'kebab-case':
                return words.join('-');
            default:
                return name;
        }
    }

    /**
     * Capitalize first letter
     */
    private capitalize(word: string): string {
        return word.charAt(0).toUpperCase() + word.slice(1);
    }

    /**
     * Extract common imports from import patterns
     */
    private extractCommonImports(importPatterns: ImportPattern[]): string[] {
        const imports: string[] = [];

        for (const pattern of importPatterns) {
            if (pattern.count >= 3) {
                // Only include very common imports
                imports.push(this.formatImport(pattern));
            }
        }

        return imports;
    }

    /**
     * Format import statement from pattern
     */
    private formatImport(pattern: ImportPattern): string {
        const quote = this.style.quotes === 'single' ? "'" : '"';
        const semi = this.style.semicolons ? ';' : '';

        switch (pattern.style) {
            case 'default':
                return `import ${pattern.alias} from ${quote}${pattern.module}${quote}${semi}`;
            case 'named':
                const namedImports = pattern.namedImports?.join(', ') || '';
                return `import { ${namedImports} } from ${quote}${pattern.module}${quote}${semi}`;
            case 'namespace':
                return `import * as ${pattern.alias} from ${quote}${pattern.module}${quote}${semi}`;
            case 'side-effect':
                return `import ${quote}${pattern.module}${quote}${semi}`;
        }
    }

    /**
     * Render template with Mustache-like syntax
     * 
     * Supports:
     * - {{variable}} - Variable substitution
     * - {{#condition}}...{{/condition}} - Conditional blocks (for booleans and arrays)
     * - {{^condition}}...{{/condition}} - Inverted conditionals
     */
    public renderTemplate(template: string, variables: TemplateVariables): string {
        let result = template;

        // Process array iterations and conditionals together
        result = this.processBlockStatements(result, variables);

        // Process simple variable substitutions
        result = this.processVariables(result, variables);

        return result;
    }

    /**
     * Process block statements (both conditionals and iterations)
     */
    private processBlockStatements(template: string, variables: TemplateVariables): string {
        let result = template;

        // Regular blocks ({{#key}}...{{/key}})
        const blockRegex = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
        result = result.replace(blockRegex, (match, key, content) => {
            const value = variables[key];
            
            // Handle arrays (iteration)
            if (Array.isArray(value)) {
                return value.map(item => {
                    if (typeof item === 'object' && item !== null) {
                        return this.processVariables(content, item as TemplateVariables);
                    }
                    // For primitive arrays, use special {{.}} syntax
                    return content.replace(/\{\{\.\}\}/g, String(item));
                }).join('');
            }
            
            // Handle objects (nested context)
            if (typeof value === 'object' && value !== null) {
                return this.processVariables(content, value as TemplateVariables);
            }
            
            // Handle conditionals (boolean/truthy check)
            const isTruthy = !!value;
            return isTruthy ? content : '';
        });

        // Inverted conditionals ({{^key}}...{{/key}})
        const invertedRegex = /\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
        result = result.replace(invertedRegex, (match, key, content) => {
            const value = variables[key];
            const isFalsy = !value || (Array.isArray(value) && value.length === 0);
            return isFalsy ? content : '';
        });

        return result;
    }

    /**
     * Process simple variable substitutions {{variable}}
     */
    private processVariables(template: string, variables: TemplateVariables): string {
        let result = template;

        const variableRegex = /\{\{(\w+)\}\}/g;
        result = result.replace(variableRegex, (match, key) => {
            const value = variables[key];
            
            if (value === undefined || value === null) {
                return '';
            }
            
            if (typeof value === 'object') {
                return JSON.stringify(value);
            }
            
            return String(value);
        });

        return result;
    }

    /**
     * Generate function using template with patterns
     */
    public generateFunctionWithTemplate(
        context: AdvancedTemplateContext,
        customTemplate?: string
    ): CompiledTemplate {
        const template = customTemplate || this.getDefaultFunctionTemplate();
        
        const code = this.renderTemplate(template, {
            name: context.name || 'generatedFunction',
            params: context.params || [],
            returnType: context.returnType || 'void',
            description: context.description,
            export: context.export,
            async: context.async,
            ...context.variables,
        });

        return {
            code: this.applyStyle(code),
            imports: context.patterns ? this.extractCommonImports(context.patterns.imports) : [],
        };
    }

    /**
     * Get default function template with Mustache syntax
     */
    private getDefaultFunctionTemplate(): string {
        return `{{#description}}
/**
 * {{description}}
 */
{{/description}}{{#export}}export {{/export}}{{#async}}async {{/async}}function {{name}}({{#params}}{{name}}: {{type}}{{^last}}, {{/last}}{{/params}}){{#returnType}}: {{returnType}}{{/returnType}} {
  // TODO: Implement {{name}}
}`;
    }

    /**
     * Apply style formatting to generated code
     */
    private applyStyle(code: string): string {
        const indent = this.getIndent();
        const lineEnding = this.getLineEnding();

        // Apply indentation (normalize to configured indent)
        const lines = code.split('\n');
        const styledLines = lines.map(line => {
            const leadingSpaces = line.match(/^\s*/)?.[0].length || 0;
            const indentLevel = Math.floor(leadingSpaces / 2);
            const content = line.trim();
            return content ? indent.repeat(indentLevel) + content : '';
        });

        return styledLines.join(lineEnding);
    }

    /**
     * Generate class using template with patterns
     */
    public generateClassWithTemplate(
        context: AdvancedTemplateContext,
        customTemplate?: string
    ): CompiledTemplate {
        if (customTemplate) {
            const code = this.renderTemplate(customTemplate, {
                name: context.name || 'GeneratedClass',
                extends: context.extends,
                implements: context.implements,
                properties: context.properties || [],
                methods: context.methods || [],
                description: context.description,
                export: context.export,
                ...context.variables,
            });

            return {
                code: this.applyStyle(code),
                imports: context.patterns ? this.extractCommonImports(context.patterns.imports) : [],
            };
        }

        // Use SimpleTemplateGenerator for default template
        const code = this.generate('class', context);

        return {
            code,
            imports: context.patterns ? this.extractCommonImports(context.patterns.imports) : [],
        };
    }

    /**
     * Get default class template with Mustache syntax
     */
    private getDefaultClassTemplate(): string {
        return `{{#description}}
/**
 * {{description}}
 */
{{/description}}{{#export}}export {{/export}}class {{name}}{{#extends}} extends {{extends}}{{/extends}}{{#implements}} implements {{implements}}{{/implements}} {
{{#properties}}
  {{visibility}} {{name}}: {{type}};
{{/properties}}
{{#methods}}

  {{#async}}async {{/async}}{{name}}({{#params}}{{name}}: {{type}}{{^last}}, {{/last}}{{/params}}){{#returnType}}: {{returnType}}{{/returnType}} {
    // TODO: Implement {{name}}
  }
{{/methods}}
}`;
    }
}
