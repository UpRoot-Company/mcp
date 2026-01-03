import { describe, it, expect, beforeEach } from '@jest/globals';
import { SimpleTemplateGenerator } from '../../generation/SimpleTemplateGenerator.js';
import type { CodeStyle } from '../../generation/StyleInference.js';

describe('SimpleTemplateGenerator - Phase 2.5 Quick Code Generation', () => {
    let generator: SimpleTemplateGenerator;
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

        generator = new SimpleTemplateGenerator(style);
    });

    describe('Function generation', () => {
        it('should generate a simple function', () => {
            const code = generator.generate('function', {
                name: 'calculateTotal',
            });

            expect(code).toContain('function calculateTotal()');
            expect(code).toContain('// TODO: Implement calculateTotal');
        });

        it('should generate function with parameters', () => {
            const code = generator.generate('function', {
                name: 'add',
                params: 'a: number, b: number',
                returnType: 'number',
            });

            expect(code).toContain('function add(a: number, b: number): number');
        });

        it('should respect export flag', () => {
            const code = generator.generate('function', {
                name: 'test',
                export: true,
            });

            expect(code).toContain('export function test()');
        });

        it('should include JSDoc when description provided', () => {
            const code = generator.generate('function', {
                name: 'test',
                description: 'Calculates the total price',
            });

            expect(code).toContain('/**');
            expect(code).toContain('* Calculates the total price');
            expect(code).toContain('*/');
        });

        it('should respect semicolon style', () => {
            const code = generator.generate('function', {
                name: 'test',
            });

            // Last line should be closing brace without semicolon
            const lines = code.split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toBe('}');
        });
    });

    describe('Class generation', () => {
        it('should generate a simple class', () => {
            const code = generator.generate('class', {
                name: 'UserService',
            });

            expect(code).toContain('class UserService {');
            expect(code).toContain('// TODO: Add properties and methods');
        });

        it('should generate exported class', () => {
            const code = generator.generate('class', {
                name: 'UserService',
                export: true,
            });

            expect(code).toContain('export class UserService');
        });

        it('should support class inheritance', () => {
            const code = generator.generate('class', {
                name: 'AdminService',
                extends: 'UserService',
            });

            expect(code).toContain('class AdminService extends UserService');
        });

        it('should support interface implementation', () => {
            const code = generator.generate('class', {
                name: 'UserService',
                implements: ['IUserService', 'ILoggable'],
            });

            expect(code).toContain('class UserService implements IUserService, ILoggable');
        });

        it('should generate properties', () => {
            const code = generator.generate('class', {
                name: 'User',
                properties: [
                    { name: 'id', type: 'string' },
                    { name: 'name', type: 'string', readonly: true },
                    { name: 'age', type: 'number', optional: true },
                ],
            });

            expect(code).toContain('id: string;');
            expect(code).toContain('readonly name: string;');
            expect(code).toContain('age?: number;');
        });

        it('should generate methods', () => {
            const code = generator.generate('class', {
                name: 'Calculator',
                methods: [
                    { name: 'add', params: 'a: number, b: number', returnType: 'number' },
                    { name: 'subtract', params: 'a: number, b: number', returnType: 'number', visibility: 'private' },
                ],
            });

            expect(code).toContain('add(a: number, b: number): number {');
            expect(code).toContain('private subtract(a: number, b: number): number {');
        });

        it('should support async methods', () => {
            const code = generator.generate('class', {
                name: 'ApiService',
                methods: [
                    { name: 'fetchData', returnType: 'Promise<Data>', async: true },
                ],
            });

            expect(code).toContain('async fetchData(): Promise<Data>');
        });

        it('should add blank lines between methods', () => {
            const code = generator.generate('class', {
                name: 'Test',
                methods: [
                    { name: 'method1' },
                    { name: 'method2' },
                ],
            });

            const lines = code.split('\n');
            const method1Index = lines.findIndex(l => l.includes('method1'));
            const method2Index = lines.findIndex(l => l.includes('method2'));

            // Should have blank line between methods
            expect(lines[method2Index - 1].trim()).toBe('');
        });
    });

    describe('Interface generation', () => {
        it('should generate a simple interface', () => {
            const code = generator.generate('interface', {
                name: 'User',
            });

            expect(code).toContain('interface User {');
            expect(code).toContain('// TODO: Add properties and methods');
        });

        it('should generate exported interface', () => {
            const code = generator.generate('interface', {
                name: 'User',
                export: true,
            });

            expect(code).toContain('export interface User');
        });

        it('should support interface extension', () => {
            const code = generator.generate('interface', {
                name: 'AdminUser',
                extends: 'User',
            });

            expect(code).toContain('interface AdminUser extends User');
        });

        it('should generate interface properties', () => {
            const code = generator.generate('interface', {
                name: 'User',
                properties: [
                    { name: 'id', type: 'string' },
                    { name: 'name', type: 'string', readonly: true },
                    { name: 'email', type: 'string', optional: true },
                ],
            });

            expect(code).toContain('id: string;');
            expect(code).toContain('readonly name: string;');
            expect(code).toContain('email?: string;');
        });

        it('should generate method signatures', () => {
            const code = generator.generate('interface', {
                name: 'Calculator',
                methods: [
                    { name: 'add', params: 'a: number, b: number', returnType: 'number' },
                ],
            });

            expect(code).toContain('add(a: number, b: number): number;');
        });
    });

    describe('Style application', () => {
        it('should use tabs when configured', () => {
            const tabStyle: CodeStyle = {
                ...style,
                indent: 'tabs',
            };
            const tabGenerator = new SimpleTemplateGenerator(tabStyle);

            const code = tabGenerator.generate('function', { name: 'test' });

            expect(code).toContain('\t// TODO');
        });

        it('should use 4-space indentation when configured', () => {
            const fourSpaceStyle: CodeStyle = {
                ...style,
                indentSize: 4,
            };
            const fourSpaceGenerator = new SimpleTemplateGenerator(fourSpaceStyle);

            const code = fourSpaceGenerator.generate('function', { name: 'test' });

            expect(code).toContain('    // TODO'); // 4 spaces
        });

        it('should omit semicolons when configured', () => {
            const noSemiStyle: CodeStyle = {
                ...style,
                semicolons: false,
            };
            const noSemiGenerator = new SimpleTemplateGenerator(noSemiStyle);

            const code = noSemiGenerator.generate('interface', {
                name: 'Test',
                properties: [{ name: 'x', type: 'number' }],
            });

            expect(code).toContain('x: number'); // No semicolon
            expect(code).not.toContain('x: number;');
        });

        it('should use CRLF line endings when configured', () => {
            const crlfStyle: CodeStyle = {
                ...style,
                lineEndings: 'crlf',
            };
            const crlfGenerator = new SimpleTemplateGenerator(crlfStyle);

            const code = crlfGenerator.generate('function', { name: 'test' });

            expect(code).toContain('\r\n');
        });

        it('should apply double quotes when configured', () => {
            const doubleQuoteStyle: CodeStyle = {
                ...style,
                quotes: 'double',
            };
            const doubleQuoteGenerator = new SimpleTemplateGenerator(doubleQuoteStyle);

            const quoted = doubleQuoteGenerator.applyQuoteStyle('hello');

            expect(quoted).toBe('"hello"');
        });

        it('should apply single quotes when configured', () => {
            const quoted = generator.applyQuoteStyle('hello');

            expect(quoted).toBe("'hello'");
        });
    });

    describe('Real-world scenarios', () => {
        it('should generate a complete REST API class', () => {
            const code = generator.generate('class', {
                name: 'UserApiService',
                export: true,
                description: 'Service for user-related API operations',
                properties: [
                    { name: 'baseUrl', type: 'string', readonly: true, visibility: 'private' },
                ],
                methods: [
                    { 
                        name: 'getUser', 
                        params: 'id: string', 
                        returnType: 'Promise<User>', 
                        async: true 
                    },
                    { 
                        name: 'createUser', 
                        params: 'user: CreateUserDto', 
                        returnType: 'Promise<User>', 
                        async: true 
                    },
                ],
            });

            expect(code).toContain('export class UserApiService');
            expect(code).toContain('Service for user-related API operations');
            expect(code).toContain('private readonly baseUrl: string;');
            expect(code).toContain('async getUser(id: string): Promise<User>');
            expect(code).toContain('async createUser(user: CreateUserDto): Promise<User>');
        });

        it('should generate a DTO interface', () => {
            const code = generator.generate('interface', {
                name: 'CreateUserDto',
                export: true,
                description: 'Data transfer object for creating a user',
                properties: [
                    { name: 'name', type: 'string' },
                    { name: 'email', type: 'string' },
                    { name: 'age', type: 'number', optional: true },
                ],
            });

            expect(code).toContain('export interface CreateUserDto');
            expect(code).toContain('name: string;');
            expect(code).toContain('email: string;');
            expect(code).toContain('age?: number;');
        });
    });

    describe('Performance', () => {
        it('should generate code within 200ms', () => {
            const startTime = Date.now();
            
            for (let i = 0; i < 100; i++) {
                generator.generate('function', {
                    name: `func${i}`,
                    params: 'a: number, b: number',
                    returnType: 'number',
                });
            }

            const duration = Date.now() - startTime;
            expect(duration).toBeLessThan(200);
        });
    });

    describe('Configuration', () => {
        it('should expose current style configuration', () => {
            const currentStyle = generator.getStyle();

            expect(currentStyle).toEqual(style);
        });
    });
});
