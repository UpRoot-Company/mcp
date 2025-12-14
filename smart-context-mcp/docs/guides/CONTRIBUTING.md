# Contributing to Smart Context MCP

We love contributions! This guide explains how to set up the development environment, run tests, and submit changes.

---

## Quick Start

### 1. Fork & Clone

```bash
# Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/smart-context-mcp.git
cd smart-context-mcp
```

### 2. Install Dependencies

```bash
npm install
# or
pnpm install
```

### 3. Run Tests

```bash
npm test
# Watch mode for development
npm test -- --watch
```

### 4. Start Development Server

```bash
npm run dev
# Starts in watch mode with hot reload
```

**Ready to code!** Pick an issue or create a new one first.

---

## Development Setup

### Prerequisites

- **Node.js:** v18.0.0 or higher
- **npm:** v9.0.0 or higher
- **Git:** For version control

Verify versions:
```bash
node --version   # Should be v18+
npm --version    # Should be v9+
git --version    # Any recent version
```

### Project Structure

```
smart-context-mcp/
├── src/
│   ├── ast/              # AST parsing and analysis
│   ├── engine/           # Core search, edit, analysis engines
│   ├── indexing/         # SQLite persistence layer
│   ├── platform/         # File system abstraction
│   ├── errors/           # Error handling & enhancement
│   ├── utils/            # Utilities
│   ├── types.ts          # Type definitions
│   └── index.ts          # Main server entry point
├── src/tests/            # All test files
├── docs/                 # Existing documentation
├── docs/             # New documentation (being built)
├── package.json
└── tsconfig.json
```

### Build

```bash
# Compile TypeScript to JavaScript
npm run build

# Output: dist/ directory
ls dist/  # Should show compiled .js files
```

---

## Code Style

Smart Context follows TypeScript best practices from `.cursorrules`.

### TypeScript Conventions

**File names:** camelCase for files
```bash
✅ src/engine/SearchEngine.ts
❌ src/engine/search-engine.ts
❌ src/engine/search_engine.ts
```

**Class names:** PascalCase
```typescript
✅ class SymbolIndex { }
❌ class symbolIndex { }
```

**Method names:** camelCase
```typescript
✅ searchSymbols(query: string) { }
❌ search_symbols(query: string) { }
```

**Constants:** UPPER_SNAKE_CASE
```typescript
✅ const MAX_CACHE_SIZE = 200;
❌ const maxCacheSize = 200;
```

**Interfaces:** PascalCase with `I` prefix (optional but conventional)
```typescript
✅ interface ISearchResult { }
✅ type SearchResult = { }  // Also acceptable
```

### Formatting Rules

**Indentation:** 2 spaces (not tabs)
```typescript
export class MyClass {
  private property: string;

  constructor() {
    this.property = "value";
  }
}
```

**Line length:** Max 100 characters (soft limit)

**Imports:** Group by category
```typescript
// 1. External dependencies
import { EventEmitter } from 'events';
import * as fs from 'fs';

// 2. Internal modules
import { SearchEngine } from './engine/Search';
import { SymbolIndex } from './ast/SymbolIndex';

// 3. Types
import type { SearchResult } from './types';
```

**Comments:** Explain WHY, not WHAT
```typescript
// ✅ Good: Explains the reasoning
// We use Levenshtein distance here instead of regex because
// it tolerates formatting differences (extra spaces, tabs)
const distance = levenshteinDistance(target, actual);

// ❌ Bad: Just restates the code
// Calculate the Levenshtein distance
const distance = levenshteinDistance(target, actual);
```

---

## Testing

All code changes require tests. Aim for >80% coverage.

### Running Tests

```bash
# Run all tests
npm test

# Watch mode (auto-rerun on changes)
npm test -- --watch

# Coverage report
npm test -- --coverage

# Test specific file
npm test -- SearchEngine.test.ts
```

### Writing Tests

**Test location:** `src/tests/` with same structure as `src/`

```typescript
// src/engine/Search.ts
export class SearchEngine { }

// src/tests/SearchEngine.test.ts (same file name)
import { SearchEngine } from '../engine/Search';

describe('SearchEngine', () => {
  describe('search', () => {
    it('should find symbols by name', () => {
      const engine = new SearchEngine();
      const results = engine.search('validateUser');
      
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toContain('validate');
    });

    it('should return empty array if no matches', () => {
      const engine = new SearchEngine();
      const results = engine.search('nonexistentSymbol123456');
      
      expect(results).toEqual([]);
    });
  });
});
```

### Test Checklist

Before submitting, ensure:
- [ ] All new code has tests
- [ ] All tests pass (`npm test`)
- [ ] Coverage is >80% for new code
- [ ] No console.log statements (use logger instead)
- [ ] No skipped tests (no `.skip`)

---

## Git Workflow

### 1. Create a Branch

```bash
# Update main first
git checkout main
git pull origin main

# Create feature branch (use descriptive name)
git checkout -b feat/add-filename-search
# or for bug fixes:
git checkout -b fix/symbol-caching-race-condition
```

### 2. Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat:` New feature
- `fix:` Bug fix
- `refactor:` Code restructuring (no behavior change)
- `test:` Test additions
- `docs:` Documentation
- `perf:` Performance improvement
- `chore:` Dependency updates, tooling

**Examples:**

```bash
# Feature
git commit -m "feat(search): add filename search type"

# Bug fix
git commit -m "fix(editor): prevent TOCTOU race condition in edit validation"

# Documentation
git commit -m "docs: add configuration guide for environment variables"

# Performance
git commit -m "perf(search): optimize trigram filtering for large files"
```

### 3. Push & Create Pull Request

```bash
# Push your branch
git push origin feat/add-filename-search

# Create PR on GitHub (cli-friendly):
gh pr create --title "Add filename search support" \
  --body "Implements type='filename' for search_project tool"
```

**PR template:**
```markdown
## Description
Brief description of changes

## Related Issues
Closes #123

## Changes Made
- [ ] Added filename search type
- [ ] Added tests for new functionality
- [ ] Updated documentation

## Testing
How to test these changes...

## Checklist
- [ ] Code follows style guidelines
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] No breaking changes
```

---

## Architecture Decision Records (ADRs)

For significant architectural decisions, create an ADR.

**When to write an ADR:**
- Adding a new core component
- Major refactoring
- New dependency
- Performance optimization

**Template:** See `docs/adr/ADR-001-smart-context-architecture.md`

**Location:** `docs/adr/ADR-NNN-<title>.md`

**Name format:** Use next number, descriptive kebab-case title

```bash
docs/adr/ADR-027-real-time-index-updates.md
```

---

## Documentation

### Update Docs When:

- [ ] Adding new tools or parameters
- [ ] Changing configuration options
- [ ] Updating performance characteristics
- [ ] Adding new workflow patterns

### Documentation Files

- **Getting Started:** `docs_n../guides/getting-started.md`
- **API Reference:** `docs/agent/TOOL_REFERENCE.md`
- **Configuration:** `docs_n../guides/configuration.md`
- **Architecture:** `docs_n../architecture/*.md`

---

## Performance Benchmarking

For performance-critical changes, run benchmarks:

```bash
# Run performance tests
npm run benchmark

# Compare with baseline
npm run benchmark -- --baseline
```

**Key metrics to track:**
- Search latency (P50, P95, P99)
- Memory usage
- Startup time
- Edit success rate

---

## Security Considerations

When modifying security-sensitive code:

1. **Path validation:** Always validate paths against `SMART_CONTEXT_ROOT`
2. **Hash verification:** Use xxHash64 for edit validation
3. **Input sanitization:** Validate all user inputs
4. **Error handling:** Don't leak sensitive info in error messages

**Security checklist:**
- [ ] No directory traversal vulnerabilities
- [ ] No command injection risks
- [ ] No unvalidated file access
- [ ] Error messages don't expose paths

---

## Code Review Process

### What We Look For

1. **Correctness:** Does it solve the problem?
2. **Style:** Follows conventions?
3. **Tests:** Are all cases covered?
4. **Performance:** Any regressions?
5. **Documentation:** Clear for future developers?

### Tips for Good Reviews

- Keep PRs focused (one feature per PR)
- Link to related issues
- Add comments explaining "why" not "what"
- Include performance numbers if relevant

---

## Release Process

(For maintainers only)

```bash
# Update version in package.json
npm version patch  # or minor/major

# Run all checks
npm test
npm run lint
npm run build

# Create tag
git tag v1.0.0

# Push and create release
git push origin main --tags
gh release create v1.0.0 --title "v1.0.0" --notes "..."
```

---

## Troubleshooting

### Tests Fail on First Run

**Cause:** Index database might not be initialized

**Fix:**
```bash
rm -rf .smart-context/
npm test
```

### TypeScript Compilation Errors

**Fix:**
```bash
# Clear cache and rebuild
rm -rf dist/
npm run build
```

### Node Modules Issues

**Fix:**
```bash
rm -rf node_modules package-lock.json
npm install
```

---

## Getting Help

- **Questions:** Create a GitHub Discussion
- **Bugs:** Open an Issue with reproduction steps
- **Architecture:** Check `docs/adr/` first
- **API Details:** See `docs/agent/TOOL_REFERENCE.md`

---

## Code of Conduct

Please note: This project has a Code of Conduct. By participating, you agree to:

- Be respectful and inclusive
- Assume good intent
- Focus on constructive feedback
- Report violations to maintainers

---

## What to Contribute

### Good First Issues

- 📝 Documentation improvements
- ✅ Adding test cases
- 🐛 Small bug fixes
- ♻️ Refactoring with tests

### Intermediate Issues

- 🔧 New tools or tool enhancements
- 📊 Performance optimizations
- 🧪 Test infrastructure improvements

### Advanced Issues

- 🏗️ Major refactoring
- 🎯 New algorithms or search types
- 🔐 Security enhancements
- 📈 Architecture improvements

---

## Thank You!

We appreciate all contributions, whether code, documentation, bug reports, or ideas. You make Smart Context better! 🙏

---

**For questions, reach out:** [GitHub Issues](https://github.com/your-org/smart-context-mcp/issues)

**Happy coding!**

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-14
