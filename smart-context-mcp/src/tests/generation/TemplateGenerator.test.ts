import { describe, it, expect, beforeEach } from '@jest/globals';
import { TemplateGenerator, type AdvancedTemplateContext, type TemplateVariables } from '../../generation/TemplateGenerator.js';
import type { CodeStyle } from '../../generation/StyleInference.js';
import type { ProjectPatterns } from '../../generation/PatternExtractor.js';

describe('TemplateGenerator - Phase 3 Full Code Generation', () => {
    let generator: TemplateGenerator;
    let style: CodeStyle;

    beforeEach(() => {
        style = {
            indent: 'spaces',
            indentSize: 2,
            quotes: 'single',
            semicolons: true,
            lineEndings: 'lf',
            trailingComma: true,
        };

        generator = new TemplateGenerator(style);
    });

    describe('Mustache-like Template Rendering', () => {
        it('should substitute simple variables', () => {
            const template = 'Hello {{name}}!';
            const variables: TemplateVariables = { name: 'World' };

            const result = generator.renderTemplate(template, variables);

            expect(result).toBe('Hello World!');
        });

        it('should handle conditional blocks', () => {
            const template = '{{#hasFeature}}Feature enabled{{/hasFeature}}';
            
            const withFeature = generator.renderTemplate(template, { hasFeature: true });
            const withoutFeature = generator.renderTemplate(template, { hasFeature: false });

            expect(withFeature).toBe('Feature enabled');
            expect(withoutFeature).toBe('');
        });

        it('should handle inverted conditionals', () => {
            const template = '{{^hasFeature}}Feature disabled{{/hasFeature}}';
            
            const withFeature = generator.renderTemplate(template, { hasFeature: true });
            const withoutFeature = generator.renderTemplate(template, { hasFeature: false });

            expect(withFeature).toBe('');
            expect(withoutFeature).toBe('Feature disabled');
        });

        it('should iterate over arrays', () => {
            const template = '{{#items}}Item: {{name}}\n{{/items}}';
            const variables: TemplateVariables = {
                items: [
                    { name: 'First' },
                    { name: 'Second' },
                    { name: 'Third' },
                ],
            };

            const result = generator.renderTemplate(template, variables);

            expect(result).toContain('Item: First');
            expect(result).toContain('Item: Second');
            expect(result).toContain('Item: Third');
        });

        it('should handle primitive arrays with {{.}} syntax', () => {
            const template = '{{#colors}}Color: {{.}}\n{{/colors}}';
            const variables: TemplateVariables = {
                colors: ['Red', 'Green', 'Blue'],
            };

            const result = generator.renderTemplate(template, variables);

            expect(result).toContain('Color: Red');
            expect(result).toContain('Color: Green');
            expect(result).toContain('Color: Blue');
        });

        it('should handle nested structures', () => {
            const template = '{{#person}}Name: {{name}}, Age: {{age}}{{/person}}';
            const variables: TemplateVariables = {
                person: { name: 'Alice', age: 30 },
            };

            const result = generator.renderTemplate(template, variables);

            expect(result).toContain('Name: Alice');
            expect(result).toContain('Age: 30');
        });

        it('should handle missing variables gracefully', () => {
            const template = 'Hello {{missing}}!';
            const variables: TemplateVariables = {};

            const result = generator.renderTemplate(template, variables);

            expect(result).toBe('Hello !');
        });
    });

    describe('Pattern-based Generation', () => {
        it('should apply naming conventions from patterns', () => {
            const patterns: ProjectPatterns = {
                imports: [],
                exports: [],
                naming: [
                    {
                        type: 'function',
                        convention: 'camelCase',
                        confidence: 0.95,
                        samples: ['calculateTotal', 'processData'],
                    },
                ],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'ProcessUserData',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('function', context);

            // Should convert PascalCase to camelCase
            expect(result.code).toContain('function processUserData');
        });

        it('should preserve original name when no pattern exists', () => {
            const patterns: ProjectPatterns = {
                imports: [],
                exports: [],
                naming: [],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'customFunction',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('function', context);

            expect(result.code).toContain('function customFunction');
        });

        it('should extract common imports from patterns', () => {
            const patterns: ProjectPatterns = {
                imports: [
                    {
                        module: 'react',
                        style: 'default',
                        alias: 'React',
                        count: 10,
                    },
                    {
                        module: 'lodash',
                        style: 'named',
                        namedImports: ['map', 'filter'],
                        count: 5,
                    },
                ],
                exports: [],
                naming: [],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'MyComponent',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('class', context);

            // Should include very common imports (count >= 3)
            expect(result.imports.length).toBeGreaterThan(0);
            expect(result.imports[0]).toContain('React');
        });
    });

    describe('Advanced Function Generation', () => {
        it('should generate function with custom template', () => {
            const customTemplate = `function {{name}}() {
  console.log('{{message}}');
}`;

            const context: AdvancedTemplateContext = {
                name: 'greet',
                variables: {
                    message: 'Hello, World!',
                },
            };

            const result = generator.generateFunctionWithTemplate(context, customTemplate);

            expect(result.code).toContain('function greet');
            expect(result.code).toContain("console.log('Hello, World!')");
        });

        it('should use default function template when no custom template provided', () => {
            const context: AdvancedTemplateContext = {
                name: 'calculate',
                description: 'Performs calculation',
                export: true,
                async: true,
                returnType: 'Promise<number>',
            };

            const result = generator.generateFunctionWithTemplate(context);

            expect(result.code).toContain('/**');
            expect(result.code).toContain('Performs calculation');
            expect(result.code).toContain('export async function calculate');
            expect(result.code).toContain('Promise<number>');
        });
    });

    describe('Advanced Class Generation', () => {
        it('should generate class with custom template', () => {
            const customTemplate = `class {{name}} {
{{#properties}}
  {{name}}: {{type}};
{{/properties}}
}`;

            const context: AdvancedTemplateContext = {
                name: 'User',
                variables: {
                    properties: [
                        { name: 'id', type: 'string' },
                        { name: 'name', type: 'string' },
                    ],
                },
            };

            const result = generator.generateClassWithTemplate(context, customTemplate);

            expect(result.code).toContain('class User');
            expect(result.code).toContain('id: string');
            expect(result.code).toContain('name: string');
        });

        it('should use default class template when no custom template provided', () => {
            const context: AdvancedTemplateContext = {
                name: 'Service',
                description: 'Main service class',
                export: true,
                extends: 'BaseService',
                properties: [
                    { name: 'config', type: 'Config', visibility: 'private' },
                ],
                methods: [
                    { name: 'initialize', returnType: 'void' },
                ],
            };

            const result = generator.generateClassWithTemplate(context);

            expect(result.code).toContain('/**');
            expect(result.code).toContain('Main service class');
            expect(result.code).toContain('export class Service extends BaseService');
            expect(result.code).toContain('private config: Config');
            expect(result.code).toContain('initialize(): void');
        });
    });

    describe('Naming Convention Conversion', () => {
        it('should convert to camelCase', () => {
            const patterns: ProjectPatterns = {
                imports: [],
                exports: [],
                naming: [
                    {
                        type: 'function',
                        convention: 'camelCase',
                        confidence: 1.0,
                        samples: [],
                    },
                ],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'ProcessUserData',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('function', context);

            expect(result.code).toContain('processUserData');
        });

        it('should convert to PascalCase', () => {
            const patterns: ProjectPatterns = {
                imports: [],
                exports: [],
                naming: [
                    {
                        type: 'class',
                        convention: 'PascalCase',
                        confidence: 1.0,
                        samples: [],
                    },
                ],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'user_service',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('class', context);

            expect(result.code).toContain('class UserService');
        });

        it('should convert to snake_case', () => {
            const patterns: ProjectPatterns = {
                imports: [],
                exports: [],
                naming: [
                    {
                        type: 'function',
                        convention: 'snake_case',
                        confidence: 1.0,
                        samples: [],
                    },
                ],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'ProcessUserData',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('function', context);

            expect(result.code).toContain('process_user_data');
        });
    });

    describe('Fallback to Simple Generation', () => {
        it('should fall back to SimpleTemplateGenerator when patterns not used', () => {
            const context: AdvancedTemplateContext = {
                name: 'simpleFunction',
                returnType: 'void',
            };

            const result = generator.generateAdvanced('function', context);

            expect(result.code).toContain('function simpleFunction');
            expect(result.imports).toEqual([]);
        });

        it('should apply variable substitution even without patterns', () => {
            const context: AdvancedTemplateContext = {
                name: 'greet',
                variables: {
                    message: 'Hello',
                },
            };

            // Generate simple function and manually add {{message}} placeholder
            const result = generator.generateAdvanced('function', context);

            expect(result.code).toContain('function greet');
        });
    });

    describe('Import Formatting', () => {
        it('should format default imports correctly', () => {
            const patterns: ProjectPatterns = {
                imports: [
                    {
                        module: 'react',
                        style: 'default',
                        alias: 'React',
                        count: 5,
                    },
                ],
                exports: [],
                naming: [],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'Component',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('class', context);

            expect(result.imports).toContain("import React from 'react';");
        });

        it('should format named imports correctly', () => {
            const patterns: ProjectPatterns = {
                imports: [
                    {
                        module: 'lodash',
                        style: 'named',
                        namedImports: ['map', 'filter'],
                        count: 4,
                    },
                ],
                exports: [],
                naming: [],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'Utils',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('class', context);

            expect(result.imports).toContain("import { map, filter } from 'lodash';");
        });

        it('should format namespace imports correctly', () => {
            const patterns: ProjectPatterns = {
                imports: [
                    {
                        module: 'fs',
                        style: 'namespace',
                        alias: 'fs',
                        count: 3,
                    },
                ],
                exports: [],
                naming: [],
                fileOrg: {
                    fileNamePattern: '*.ts',
                    directoryPattern: 'src',
                },
                affixes: {
                    prefixes: [],
                    suffixes: [],
                },
            };

            const context: AdvancedTemplateContext = {
                name: 'FileHandler',
                usePatterns: true,
                patterns,
            };

            const result = generator.generateAdvanced('class', context);

            expect(result.imports).toContain("import * as fs from 'fs';");
        });
    });
});
