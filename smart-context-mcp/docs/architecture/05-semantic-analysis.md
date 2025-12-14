# Semantic Analysis

**Understanding code structure through AST parsing, skeleton generation, and dependency graphs.**

---

## 1. Why Tree-sitter?

### The Problem

Parsing code correctly is hard:
- Different languages have different syntax
- Real-world code often has syntax errors (during development)
- Performance matters (parse 10K files quickly)

### Comparison of Approaches

| Approach | Speed | Accuracy | Error Recovery | Languages |
|----------|-------|----------|-----------------|-----------|
| **Regex** | ⚡⚡⚡ Very Fast | ⭐ Poor | ❌ No | Single |
| **Babel** (JS only) | ⚡⚡ Fast | ⭐⭐⭐ Great | ⚠️ Limited | JavaScript |
| **Tree-sitter** | ⚡⚡ Fast | ⭐⭐⭐ Excellent | ✅ Excellent | Multi-language |

### Tree-sitter Advantages

- **WASM**: Runs in JavaScript, no native dependencies
- **Error Resilient**: Parses broken code gracefully (missing semicolons, unclosed braces)
- **Fast**: Incremental parsing (only re-parse changed sections)
- **Multi-language**: Same API for TypeScript, Python, Go, Rust, etc.
- **Query Language**: S-expressions for finding patterns

---

## 2. Symbol Extraction Deep Dive

### Stage 1: Parse to AST

**Input:**
```typescript
export class User {
  private id: string;
  
  constructor(id: string) {
    this.id = id;
  }
  
  getName(): string {
    return this.id;
  }
}
```

**Tree-sitter Output (AST):**
```
program
  export_statement
    class_declaration
      name: "User"
      class_body
        property_declaration
          name: "id"
          type: "string"
        constructor_declaration
          parameters: [...] 
          block: [...]
        method_definition
          name: "getName"
          return_type: "string"
          block: [...]
```

### Stage 2: Query with S-expressions

**Tree-sitter Query Language:**
```scheme
;; Find all class/function definitions
(
  (class_declaration name: (type_identifier) @name)
  (function_declaration name: (identifier) @name)
)

;; Find all function parameters
(function_declaration parameters: (formal_parameters (parameter) @param))

;; Find all imports
(import_statement source: (string) @source)
```

### Stage 3: Extract Metadata

**From src/ast/SymbolIndex.ts (lines 150-250):**

```typescript
interface ExtractedSymbol {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'variable' | 'export';
  range: { startLine: number; endLine: number; };
  signature?: string;  // Full function signature
  parameters?: string[];
  returnType?: string;
  doc?: string;  // JSDoc comment
  modifiers?: string[];  // public, private, async, static, etc.
}

class SymbolIndex {
  extractSymbols(filePath: string, ast: Tree): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    
    // Query 1: Class definitions
    const classQuery = this.parser.query(`
      (class_declaration 
        name: (type_identifier) @name
        (class_body) @body)
    `);
    
    for (const match of classQuery.matches(ast.rootNode)) {
      symbols.push({
        name: match.name.text,
        kind: 'class',
        range: {
          startLine: match.node.startPosition.row,
          endLine: match.node.endPosition.row
        },
        doc: this.extractDocComment(match.node)
      });
    }
    
    // Query 2: Function definitions
    const functionQuery = this.parser.query(`
      (function_declaration
        name: (identifier) @name
        parameters: (formal_parameters) @params
        return_type: (type_annotation) @return)
    `);
    
    for (const match of functionQuery.matches(ast.rootNode)) {
      symbols.push({
        name: match.name.text,
        kind: 'function',
        parameters: match.params.text.split(','),
        returnType: match.return.text,
        range: { ... }
      });
    }
    
    return symbols;
  }
}
```

### Performance

| Operation | Time | Notes |
|-----------|------|-------|
| **Parse file** | 50-150ms | Including AST building |
| **Extract symbols** | 10-30ms | Query execution |
| **Total per file** | 60-180ms | 1000-line file |
| **Indexing 10K files** | 10-30 minutes | Parallel processing |

---

## 3. Skeleton Generation Algorithm

### Goal

Show structure without implementation to save 95-98% tokens.

### Algorithm Steps

**Step 1: Parse to AST**
```
Input: 500-line file
Output: AST tree
```

**Step 2: Traverse looking for declarations**
```typescript
function generateSkeleton(ast: AST, detailLevel: 'minimal' | 'standard' | 'detailed'): string {
  const lines: string[] = [];
  
  traverse(ast.rootNode, (node) => {
    switch (node.type) {
      case 'class_declaration':
        lines.push(`class ${getClassName(node)} {`);
        // Include public methods only
        for (const child of node.children) {
          if (child.type === 'method_definition' && isPublic(child)) {
            lines.push(`  ${getMethodSignature(child)} { /* ... */ }`);
          }
        }
        lines.push('}');
        break;
        
      case 'function_declaration':
        lines.push(`${getFunctionSignature(node)} { /* ... */ }`);
        break;
        
      case 'interface_declaration':
        lines.push(`interface ${getInterfaceName(node)} {`);
        for (const child of node.children) {
          if (child.type === 'property_signature') {
            lines.push(`  ${getPropertySignature(child)}`);
          }
        }
        lines.push('}');
        break;
    }
  });
  
  return lines.join('\n');
}
```

**Step 3: Fold bodies**
```
Before:
  function foo() {
    console.log('hello');
    return 42;
  }

After:
  function foo() { /* ... implementation hidden ... */ }
```

### Detail Levels

**minimal** - Only signatures
```typescript
export class Editor {
  constructor(config: EditorConfig) { /* ... */ }
  async normalize(content: string): Promise<NormalizationResult> { /* ... */ }
}
```

**standard** (default) - Signatures + member variables
```typescript
export class Editor {
  private cache: Map<string, CacheEntry> = /* ... */
  private queue: EditQueue = /* ... */
  
  constructor(config: EditorConfig) { /* ... */ }
  async normalize(content: string): Promise<NormalizationResult> { /* ... */ }
}
```

**detailed** - Includes short implementations (<5 lines)
```typescript
export class Editor {
  private cache: Map<string, CacheEntry> = new Map();
  
  constructor(config: EditorConfig) {
    this.cache.clear();
  }
  
  async normalize(content: string): Promise<NormalizationResult> { /* ... */ }
}
```

### Token Savings Analysis

**Original file (500 tokens):**
```
500-line file, full content = 500 tokens
```

**Skeleton view (15 tokens, 97% savings):**
```
Signatures only = 15 tokens
→ 97% reduction
```

**Fragment (100-line section, 100 tokens):**
```
100-line code range = 100 tokens
→ 80% reduction vs full
```

---

## 4. Call Graph Construction

### Problem Statement

"Who calls function X?" requires understanding function calls across files.

### Algorithm

**Step 1: Extract call sites from each function**
```typescript
function foo() {
  bar();           // Call to bar
  this.method();   // Method call
  asyncFn().then(result => result); // Async call
}
```

**Step 2: Resolve each call to a definition**
```
bar() → Find symbol "bar" (in same file? imported?)
this.method() → Find method definition
asyncFn() → Find async function definition
```

**Step 3: Build graph**
```
foo → [bar, this.method, asyncFn]
bar → [...]
this.method → [...]
```

### Implementation

**From src/ast/CallGraphBuilder.ts (lines 100-300):**

```typescript
interface CallGraphNode {
  symbolId: string;
  symbolName: string;
  filePath: string;
  callers: CallGraphEdge[];  // Who calls this
  callees: CallGraphEdge[];  // What this calls
}

interface CallGraphEdge {
  fromSymbolId: string;
  toSymbolId: string;
  callType: 'direct' | 'method' | 'constructor' | 'callback';
  line: number;
}

class CallGraphBuilder {
  async buildGraph(symbolId: string, maxDepth: number = 5): Promise<CallGraph> {
    const graph: CallGraph = { nodes: {}, edges: [] };
    const visited = new Set<string>();
    
    await this.dfs(symbolId, 0, maxDepth, graph, visited);
    return graph;
  }
  
  private async dfs(
    symbolId: string,
    depth: number,
    maxDepth: number,
    graph: CallGraph,
    visited: Set<string>
  ): Promise<void> {
    if (visited.has(symbolId) || depth > maxDepth) return;
    visited.add(symbolId);
    
    // Get symbol info
    const symbol = this.symbolIndex.getSymbolById(symbolId);
    if (!symbol) return;
    
    // Get all callees (what this function calls)
    const callSites = this.extractCallSites(symbol);
    
    for (const callSite of callSites) {
      const callee = this.resolveCall(callSite);
      if (callee) {
        // Add edge
        graph.edges.push({
          fromSymbolId: symbolId,
          toSymbolId: callee.id,
          callType: callSite.type,
          line: callSite.line
        });
        
        // Recurse
        await this.dfs(callee.id, depth + 1, maxDepth, graph, visited);
      }
    }
  }
  
  private extractCallSites(symbol: Symbol): CallSite[] {
    const callSites: CallSite[] = [];
    const ast = this.astManager.getAST(symbol.filePath);
    
    // Find all function calls within this symbol
    const query = this.parser.query(`
      (call_expression function: (identifier) @func)
      (call_expression function: (member_expression) @method)
    `);
    
    for (const match of query.matches(ast.rootNode)) {
      if (this.isWithinSymbol(match.node, symbol)) {
        callSites.push({
          name: match.func.text,
          type: 'direct',
          line: match.node.startPosition.row
        });
      }
    }
    
    return callSites;
  }
}
```

### Example Output

**Query: Who calls "authenticate"?**

```
Root: authenticate (src/auth.ts:12)
├─ Callers:
│  ├─ checkUser (src/auth.ts:45)
│  │  └─ Callers:
│  │     └─ handleSignup (src/routes.ts:100)
│  └─ validateRequest (src/middleware.ts:30)
│     └─ Callers:
│        └─ server.use() (src/index.ts:20)
└─ Callees:
   ├─ isValidEmail (src/utils.ts:234)
   └─ database.getUser (src/db.ts:150)
```

### Performance

| Operation | Time | Notes |
|-----------|------|-------|
| **Build graph (depth=3)** | 200-500ms | DFS traversal |
| **Build graph (depth=5)** | 500-1200ms | Deeper search |
| **Memory per graph** | 1-10MB | Depends on graph size |

---

## 5. Dependency Graph Analysis

### Purpose

Understand file-level dependencies to assess impact of changes.

### Algorithm

**Build dependency matrix:**
```
files: [a.ts, b.ts, c.ts, d.ts]

dependencies:
  a.ts imports: [b.ts, c.ts]
  b.ts imports: [c.ts]
  c.ts imports: []
  d.ts imports: [a.ts]
```

**Graph visualization:**
```
d.ts → a.ts → b.ts
         ↓      ↓
         c.ts ←┘
```

### Impact Analysis

**Find all files affected if c.ts changes:**

```typescript
function findImpactedFiles(file: string, direction: 'downstream' | 'upstream'): string[] {
  const impacted = new Set<string>();
  
  if (direction === 'downstream') {
    // Who imports this file?
    return this.dfs(file, (node) => this.getDependentsOf(node));
  } else {
    // What does this file import?
    return this.dfs(file, (node) => this.getDependenciesOf(node));
  }
}

// Result for "c.ts change":
// Downstream: [b.ts, a.ts, d.ts]  (all affected)
// Upstream: []  (c.ts has no dependencies)
```

### Circular Dependency Detection

```typescript
function hasCircularDependency(graph: DependencyGraph): boolean {
  for (const startNode of graph.nodes) {
    if (this.canReachSelf(startNode, graph)) {
      return true;
    }
  }
  return false;
}

// Example circular dependency:
// a.ts imports b.ts
// b.ts imports c.ts
// c.ts imports a.ts  ← CIRCULAR!
```

---

## 6. Comparison: Different Analysis Modes

| Mode | What It Finds | Use Case | Example |
|------|---------------|----------|---------|
| **impact** | Who depends on this | Before refactoring a file | "If I change auth.ts, who breaks?" |
| **dependencies** | What this depends on | Understanding requirements | "What does auth.ts need to work?" |
| **calls** | Function call graph | Tracing logic flow | "Who calls authenticate()?" |
| **data_flow** | Variable usage | Debugging | "Where is this variable used?" |
| **types** | Type relationships | Type system audit | "What implements this interface?" |

---

## See Also

- [02-core-engine.md](./02-core-engine.md) - Database architecture
- [04-advanced-algorithms.md](./04-advanced-algorithms.md) - Matching algorithms
- [06-reliability-engineering.md](./06-reliability-engineering.md) - Safety guarantees
- [../agent/TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) - API reference
