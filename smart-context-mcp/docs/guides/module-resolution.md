# Module Resolution Guide

Smart Context uses intelligent module resolution to understand how imports map to actual files in your project. This guide explains how it works and how to configure it.

---

## Overview

Module resolution answers the question: **When `app.ts` imports `@components/Button`, where is that file?**

Smart Context's `ModuleResolver` handles:
- ✅ Relative imports (`./`, `../`)
- ✅ Absolute imports  
- ✅ TypeScript path aliases (`@components`, `@utils`)
- ✅ Node.js modules (`react`, `lodash`)
- ✅ Monorepo projects (multiple `tsconfig.json` files)
- ✅ Directory index files (`./utils` → `./utils/index.ts`)
- ✅ Multiple file extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`)

---

## How It Works

### Resolution Strategy (Step by Step)

Smart Context attempts resolution in this order:

```
1. Check cache (fast path)
   ↓ (if miss)
2. Relative paths (./utils, ../sibling)
   ↓
3. TypeScript path aliases (@components/Button)
   ↓
4. Node.js modules (react, lodash)
   ↓
5. Bundler-style fallback (if enabled)
   ↓
6. Cache and return result
```

### Example: Tracing a Resolution

**Your code:**
```typescript
// File: /project/src/pages/Home.tsx
import Button from '@components/Button';
```

**Resolution process:**

```
Input:
  - Context file: /project/src/pages/Home.tsx
  - Import path: @components/Button

Step 1: Check cache
  → Cache miss (first time seeing this import)

Step 2: Is it relative? (starts with ./)
  → No (@components is alias)

Step 3: Is it a TypeScript alias?
  → Check tsconfig.json
  → Found! "@components/*" maps to "src/components/*"
  → Substitute: @components/Button → src/components/Button

Step 4: Resolve to absolute path
  → /project/src/components/Button

Step 5: Find with extensions
  → Check /project/src/components/Button.ts
  → Check /project/src/components/Button.tsx ✅ (Found!)

Step 6: Cache result
  → Next time, instant resolution

Result: /project/src/components/Button.tsx
```

---

## Configuration

### Basic Setup (Automatic)

By default, Smart Context auto-discovers `tsconfig.json` files:

```bash
# Smart Context will find:
- tsconfig.json
- tsconfig.base.json
- packages/*/tsconfig.json (monorepo)
- apps/*/tsconfig.json (monorepo)
```

**No configuration needed** for standard projects.

---

### TypeScript Path Aliases

Define aliases in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@components/*": ["src/components/*"],
      "@utils/*": ["src/utils/*"],
      "@types/*": ["src/types/*"]
    }
  }
}
```

**Now Smart Context understands:**
```typescript
import Button from '@components/Button';     // → src/components/Button.ts
import { formatDate } from '@utils/date';    // → src/utils/date.ts
import type { User } from '@types/user';     // → src/types/user.ts
```

---

### Monorepo Configuration

For monorepo projects, create separate `tsconfig.json` files per package:

**Structure:**
```
monorepo/
├── tsconfig.json (base config)
├── tsconfig.base.json (shared paths)
├── packages/
│   ├── ui/
│   │   ├── tsconfig.json (overrides paths)
│   │   └── src/
│   ├── api/
│   │   ├── tsconfig.json
│   │   └── src/
```

**Root `tsconfig.base.json`:**
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@packages/*": ["packages/*"],
      "@monorepo/*": ["packages/*/src"]
    }
  }
}
```

**Package `packages/ui/tsconfig.json`:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@ui/*": ["src/*"],
      "@api/*": ["../api/src/*"]
    }
  }
}
```

**Resolution in ui package:**
```typescript
import { Button } from '@ui/components';      // → packages/ui/src/components
import { apiClient } from '@api/client';      // → packages/api/src/client
import shared from '@packages/shared/src';    // → packages/shared/src
```

---

## Resolution Examples

### Relative Imports

```typescript
// In: src/pages/dashboard/Dashboard.tsx
import { Header } from '../components/Header';
// Resolves to: src/pages/components/Header.ts
// (or .tsx, .js depending on what exists)

import { utils } from '../../utils/helpers';
// Resolves to: src/utils/helpers.ts
```

**Rule:** Relative paths are resolved from the importing file's directory.

---

### Absolute Imports

```typescript
// In: src/pages/Home.tsx
import config from '/etc/app.config';  // System-absolute path
// Resolves to: /etc/app.config.js
```

⚠️ **Rare in practice** - Prefer relative or alias imports.

---

### Node.js Modules

```typescript
// In: src/app.ts
import React from 'react';
// Resolves to: node_modules/react/...

import lodash from 'lodash';
// Resolves to: node_modules/lodash/lodash.js

import type { NextPage } from 'next';
// Resolves to: node_modules/next/...
```

**How it works:** Node resolution checks:
1. `node_modules/` directory
2. Package's `package.json` → `main` field
3. Index files (`index.js`, `index.ts`, etc.)

---

### Path Aliases in Action

**TypeScript config:**
```json
{
  "compilerOptions": {
    "baseUrl": "./src",
    "paths": {
      "@/*": ["*"],
      "@components/*": ["components/*"],
      "@hooks/*": ["hooks/*"]
    }
  }
}
```

**Code:**
```typescript
// All of these work:
import Button from '@components/Button';        // ./src/components/Button.ts
import { useAuth } from '@hooks/useAuth';       // ./src/hooks/useAuth.ts
import config from '@/config/app.config';       // ./src/config/app.config.ts
```

---

### Directory Indexes

When you import a directory, Smart Context looks for index files:

```typescript
// Importing directory:
import utils from './utils';
// Smart Context checks (in order):
// 1. ./utils.ts
// 2. ./utils.tsx
// 3. ./utils/index.ts
// 4. ./utils/index.tsx
// 5. ./utils/index.js
// ... and so on
```

**Works great for organizing code:**
```
src/utils/
├── index.ts      ← Exports all utilities
├── date.ts
├── string.ts
└── math.ts
```

```typescript
import * as utils from './utils';  // Imports from index.ts
utils.formatDate(...);
utils.capitalize(...);
utils.sum(...);
```

---

## Troubleshooting

### ❌ "Cannot resolve module '@components/Button'"

**Causes:**
1. Path alias not defined in `tsconfig.json`
2. `baseUrl` is wrong
3. File doesn't exist at resolved path

**Fix:**

```bash
# 1. Check tsconfig.json exists
ls tsconfig.json

# 2. Verify alias definition
cat tsconfig.json | grep -A 10 '"paths"'
# Should show: "@components/*": ["src/components/*"]

# 3. Check file exists
ls src/components/Button.ts
# If not, create it
```

---

### ❌ Import resolves to wrong file

**Example:**
```typescript
import { Button } from '@components';
// Expected: src/components/index.ts
// Got: src/components/Button.tsx
```

**Cause:** Multiple matches and resolution ambiguity.

**Fix:**
```json
{
  "baseUrl": "src",
  "paths": {
    "@components": ["components"],        // ❌ Ambiguous
    "@components/*": ["components/*"]     // ✅ Specific
  }
}
```

Always use `/*` at end of aliases for clarity.

---

### ❌ "Resolution failed for @utils/helpers"

**In monorepo:**
```typescript
// packages/ui/src/index.ts
import { format } from '@utils/date';  // ❌ Failed

// @utils is not defined in packages/ui/tsconfig.json!
```

**Fix:** Add to `packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "paths": {
      "@utils/*": ["../api/src/utils/*"]  // ✅ Now works
    }
  }
}
```

---

### ❌ Circular imports detected

**Problem:**
```typescript
// components/Button.ts
import { theme } from './theme';

// components/theme.ts
import Button from './Button';  // ❌ Circular!
```

**Fix:** Extract shared code:
```
components/
├── Button.ts (imports from shared)
├── theme.ts (imports from shared)
└── shared.ts (no imports from Button or theme)
```

---

## Performance Tuning

### Caching

Smart Context caches resolutions automatically. For large projects:

**Cache details:**
- **Resolution cache** - Caches `(contextPath, importPath)` → resolved file path
- **File existence cache** - Avoids repeated filesystem checks
- **Directory cache** - Prevents re-scanning directories

**Clear cache if files change:**
```bash
# If adding/moving files, Smart Context detects changes
# But if needed manually:
SMART_CONTEXT_CLEAR_CACHE=true npx smart-context-mcp
```

---

### Configuration Optimization

**For large monorepos:**

```bash
# Speed up by limiting explicit config
SMART_CONTEXT_TSCONFIG_PATHS="tsconfig.json,packages/*/tsconfig.json" \
npx smart-context-mcp
```

This prevents scanning every subdirectory for configs.

---

## Advanced: Bundler-Style Resolution

For projects that allow bundler-style imports:

```typescript
// With bundler resolution enabled:
import Button from 'components/Button';  // Treats as ./components/Button
```

**Enable in code (advanced):**
```typescript
const resolver = new ModuleResolver({
  rootPath: process.cwd(),
  fallbackResolution: 'bundler'  // Enable bundler-style fallback
});
```

**Not recommended** - prefer explicit aliases for clarity.

---

## Edge Cases

### Package Exports (`package.json` exports field)

Modern Node.js packages use `exports` field:

```json
// package.json
{
  "exports": {
    ".": "./dist/index.js",
    "./components": "./dist/components/index.js"
  }
}
```

Smart Context respects this and resolves correctly.

---

### TypeScript Declaration Files

Resolution finds `.d.ts` files for type information:

```typescript
// app.ts
import type { User } from '@types/user';
// Resolves to: src/types/user.d.ts
```

Order of extension checking:
1. `.ts`
2. `.tsx`
3. `.d.ts`
4. `.js`
5. `.jsx`
6. `.json`

---

### Symlinks

By default, symlinks are **not** preserved during resolution:

```bash
# Project structure
src/
├── actual/
│   └── utils.ts
└── alias -> actual/

# Import resolves through actual path, not symlink
import { helper } from './alias/utils';
// Resolves to: src/actual/utils.ts (not through symlink)
```

---

## Debugging Resolution Issues

### Enable Detailed Diagnostics

When Smart Context can't resolve an import, check the error details:

```
Error: Cannot resolve import @missing/module

Details:
  Attempted strategies:
    1. Alias lookup: Not found in tsconfig.json
    2. Node resolution: Not in node_modules/
    3. Bundler fallback: No matching directory

Suggestion: 
  - Add "@missing/*" to tsconfig.json paths
  - Or create node_modules/@missing/module
```

### Manual Resolution Test

```typescript
const resolver = require('./ModuleResolver');
const r = new resolver.ModuleResolver('/project/root');

const result = r.resolveDetailed(
  '/project/src/app.ts',
  '@components/Button'
);

console.log(result);
// Shows: which strategies tried, which succeeded, why it failed
```

---

## Best Practices

### ✅ DO:

1. **Use path aliases** - Clearer than relative imports
   ```typescript
   import { Button } from '@components/Button';  // ✅ Clear
   ```

2. **Consistent naming** - Use `@` prefix for all aliases
   ```typescript
   "@components/*": ["src/components/*"],
   "@hooks/*": ["src/hooks/*"],
   "@utils/*": ["src/utils/*"]
   ```

3. **Use `/*` in paths** - Prevents ambiguity
   ```json
   "@components/*": ["src/components/*"]  // ✅ Specific
   "@components": ["src/components"]      // ❌ Ambiguous
   ```

4. **Monorepo: Define base config** - Share across packages
   ```json
   {
     "extends": "../../tsconfig.base.json"  // Inherit from root
   }
   ```

---

### ❌ DON'T:

1. **Don't use absolute system paths**
   ```typescript
   import config from '/etc/app.config';  // ❌ Not portable
   ```

2. **Don't deep relative imports**
   ```typescript
   import { Button } from '../../../components/Button';  // ❌ Fragile
   ```

3. **Don't mix alias styles**
   ```typescript
   import A from '@components/A';      // ✅
   import B from '~/components/B';     // ❌ (confusing)
   import C from 'components/C';       // ❌ (ambiguous)
   ```

---

## Further Reading

- [Configuration Guide](./configuration.md) - Environment variables for resolution
- [Getting Started](./getting-started.md) - Quick setup
- [TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) - API tool details
- [ADR-012: Project Intelligence](../../docs/adr/ADR-012-project-intelligence.md) - Architecture decision

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-14  
**Maintained by:** Smart Context MCP Team
