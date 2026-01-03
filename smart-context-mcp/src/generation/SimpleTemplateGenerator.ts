/**
 * ADR-042-006: Phase 2.5 - SimpleTemplateGenerator
 * 
 * Generates code from simple templates with variable substitution.
 * Supports function, class, and interface generation.
 */

import type { CodeStyle } from './StyleInference.js';

/**
 * Template variable substitution context
 */
export interface TemplateContext {
    /** Symbol name (e.g., function/class name) */
    name: string;
    /** Parameters for function/method */
    params?: string;
    /** Return type annotation */
    returnType?: string;
    /** Base class for inheritance */
    extends?: string;
    /** Interfaces to implement */
    implements?: string[];
    /** Properties for class/interface */
    properties?: PropertyDefinition[];
    /** Methods for class/interface */
    methods?: MethodDefinition[];
    /** Whether to export */
    export?: boolean;
    /** JSDoc comment */
    description?: string;
}

/**
 * Property definition for classes/interfaces
 */
export interface PropertyDefinition {
    name: string;
    type?: string;
    optional?: boolean;
    readonly?: boolean;
    visibility?: 'public' | 'private' | 'protected';
}

/**
 * Method definition for classes/interfaces
 */
export interface MethodDefinition {
    name: string;
    params?: string;
    returnType?: string;
    visibility?: 'public' | 'private' | 'protected';
    async?: boolean;
}

/**
 * Template types supported
 */
export type TemplateType = 'function' | 'class' | 'interface';

/**
 * SimpleTemplateGenerator - Phase 2.5 Quick Win
 * 
 * Generates TypeScript code from templates with:
 * - Variable substitution ({name}, {params}, {returnType})
 * - Style-aware formatting (quotes, indent, semicolons)
 * - Support for function, class, interface
 */
export class SimpleTemplateGenerator {
    constructor(private readonly style: CodeStyle) {}

    /**
     * Generate code from template type and context
     * 
     * @param type Template type (function, class, interface)
     * @param context Variables for substitution
     * @returns Generated code string
     */
    public generate(type: TemplateType, context: TemplateContext): string {
        switch (type) {
            case 'function':
                return this.generateFunction(context);
            case 'class':
                return this.generateClass(context);
            case 'interface':
                return this.generateInterface(context);
            default:
                throw new Error(`Unsupported template type: ${type}`);
        }
    }

    /**
     * Generate a function
     */
    private generateFunction(ctx: TemplateContext): string {
        const { name, params = '', returnType = 'void', export: isExport = false, description } = ctx;
        
        const lines: string[] = [];

        // Add JSDoc if description provided
        if (description) {
            lines.push('/**');
            lines.push(` * ${description}`);
            lines.push(' */');
        }

        // Build function signature
        const exportKeyword = isExport ? 'export ' : '';
        const returnTypeAnnotation = returnType ? `: ${returnType}` : '';
        const semi = this.style.semicolons ? ';' : '';
        
        lines.push(`${exportKeyword}function ${name}(${params})${returnTypeAnnotation} {`);
        lines.push(`${this.getIndent()}// TODO: Implement ${name}`);
        lines.push('}');

        return lines.join(this.getLineEnding());
    }

    /**
     * Generate a class
     */
    private generateClass(ctx: TemplateContext): string {
        const {
            name,
            extends: baseClass,
            implements: interfaces = [],
            properties = [],
            methods = [],
            export: isExport = false,
            description,
        } = ctx;

        const lines: string[] = [];

        // Add JSDoc if description provided
        if (description) {
            lines.push('/**');
            lines.push(` * ${description}`);
            lines.push(' */');
        }

        // Build class declaration
        const exportKeyword = isExport ? 'export ' : '';
        let classDecl = `${exportKeyword}class ${name}`;
        
        if (baseClass) {
            classDecl += ` extends ${baseClass}`;
        }
        
        if (interfaces.length > 0) {
            classDecl += ` implements ${interfaces.join(', ')}`;
        }
        
        classDecl += ' {';
        lines.push(classDecl);

        // Add properties
        if (properties.length > 0) {
            for (const prop of properties) {
                lines.push(this.generateProperty(prop));
            }
            
            // Add blank line after properties if there are methods
            if (methods.length > 0) {
                lines.push('');
            }
        }

        // Add methods
        for (let i = 0; i < methods.length; i++) {
            const method = methods[i];
            lines.push(...this.generateMethod(method));
            
            // Add blank line between methods (except last one)
            if (i < methods.length - 1) {
                lines.push('');
            }
        }

        // If no properties or methods, add placeholder comment
        if (properties.length === 0 && methods.length === 0) {
            lines.push(`${this.getIndent()}// TODO: Add properties and methods`);
        }

        lines.push('}');

        return lines.join(this.getLineEnding());
    }

    /**
     * Generate a property declaration
     */
    private generateProperty(prop: PropertyDefinition): string {
        const { name, type, optional = false, readonly: isReadonly = false, visibility = 'public' } = prop;
        
        const visibilityKeyword = visibility === 'public' ? '' : `${visibility} `;
        const readonlyKeyword = isReadonly ? 'readonly ' : '';
        const optionalMarker = optional ? '?' : '';
        const typeAnnotation = type ? `: ${type}` : '';
        const semi = this.style.semicolons ? ';' : '';

        return `${this.getIndent()}${visibilityKeyword}${readonlyKeyword}${name}${optionalMarker}${typeAnnotation}${semi}`;
    }

    /**
     * Generate a method declaration
     */
    private generateMethod(method: MethodDefinition): string[] {
        const {
            name,
            params = '',
            returnType = 'void',
            visibility = 'public',
            async: isAsync = false,
        } = method;

        const lines: string[] = [];
        
        const visibilityKeyword = visibility === 'public' ? '' : `${visibility} `;
        const asyncKeyword = isAsync ? 'async ' : '';
        const returnTypeAnnotation = returnType ? `: ${returnType}` : '';

        lines.push(`${this.getIndent()}${visibilityKeyword}${asyncKeyword}${name}(${params})${returnTypeAnnotation} {`);
        lines.push(`${this.getIndent(2)}// TODO: Implement ${name}`);
        lines.push(`${this.getIndent()}}`);

        return lines;
    }

    /**
     * Generate an interface
     */
    private generateInterface(ctx: TemplateContext): string {
        const {
            name,
            extends: baseInterfaces,
            properties = [],
            methods = [],
            export: isExport = false,
            description,
        } = ctx;

        const lines: string[] = [];

        // Add JSDoc if description provided
        if (description) {
            lines.push('/**');
            lines.push(` * ${description}`);
            lines.push(' */');
        }

        // Build interface declaration
        const exportKeyword = isExport ? 'export ' : '';
        let interfaceDecl = `${exportKeyword}interface ${name}`;
        
        if (baseInterfaces) {
            interfaceDecl += ` extends ${baseInterfaces}`;
        }
        
        interfaceDecl += ' {';
        lines.push(interfaceDecl);

        // Add properties
        for (const prop of properties) {
            lines.push(this.generateInterfaceProperty(prop));
        }

        // Add methods
        for (const method of methods) {
            lines.push(this.generateInterfaceMethod(method));
        }

        // If no properties or methods, add placeholder comment
        if (properties.length === 0 && methods.length === 0) {
            lines.push(`${this.getIndent()}// TODO: Add properties and methods`);
        }

        lines.push('}');

        return lines.join(this.getLineEnding());
    }

    /**
     * Generate interface property
     */
    private generateInterfaceProperty(prop: PropertyDefinition): string {
        const { name, type, optional = false, readonly: isReadonly = false } = prop;
        
        const readonlyKeyword = isReadonly ? 'readonly ' : '';
        const optionalMarker = optional ? '?' : '';
        const typeAnnotation = type ? `: ${type}` : '';
        const semi = this.style.semicolons ? ';' : '';

        return `${this.getIndent()}${readonlyKeyword}${name}${optionalMarker}${typeAnnotation}${semi}`;
    }

    /**
     * Generate interface method signature
     */
    private generateInterfaceMethod(method: MethodDefinition): string {
        const { name, params = '', returnType = 'void' } = method;
        
        const returnTypeAnnotation = returnType ? `: ${returnType}` : '';
        const semi = this.style.semicolons ? ';' : '';

        return `${this.getIndent()}${name}(${params})${returnTypeAnnotation}${semi}`;
    }

    /**
     * Get indentation string
     */
    private getIndent(level: number = 1): string {
        if (this.style.indent === 'tabs') {
            return '\t'.repeat(level);
        } else {
            return ' '.repeat(this.style.indentSize * level);
        }
    }

    /**
     * Get line ending character(s)
     */
    private getLineEnding(): string {
        return this.style.lineEndings === 'crlf' ? '\r\n' : '\n';
    }

    /**
     * Apply quote style to a string
     */
    public applyQuoteStyle(str: string): string {
        if (this.style.quotes === 'single') {
            return `'${str}'`;
        } else {
            return `"${str}"`;
        }
    }

    /**
     * Get current style configuration
     */
    public getStyle(): CodeStyle {
        return { ...this.style };
    }
}
