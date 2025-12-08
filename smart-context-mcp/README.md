# Smart Context MCP Server

An MCP (Model Context Protocol) server designed to provide LLMs with efficient, safe, and intelligent access to large codebases. Built on a "Scout → Read → Replace" pipeline, this server minimizes token usage while maximizing code understanding and editing safety.

[![Version](https://img.shields.io/badge/version-2.2.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-ISC-green.svg)](LICENSE)

## 🎯 Overview

When working with large codebases, LLMs face critical challenges:
- **Context Token Waste**: Loading entire files consumes valuable context window tokens
- **Unsafe Edits**: Ambiguous string replacements can corrupt files
- **Poor Navigation**: Difficulty finding relevant code across thousands of files

Smart Context MCP solves these problems with intelligent AST-based analysis, surgical editing with fuzzy matching, and efficient code navigation.

## ✨ Key Features

### 1. 🎯 Smart Context Retrieval
- **AST-based Skeleton Generation**: Get file outlines showing only signatures, not implementation details
- **Focused Reading**: Extract specific code regions using keywords, patterns, or line ranges
- **Interval Merging**: Automatically merge overlapping code regions to reduce token usage

### 2. 🛡️ Safe Atomic Editing
- **Advanced Fuzzy Matching**: Dynamic tolerance and optimized boundary detection for robust edits.
- **Intelligent Diagnostics**: Detailed failure analysis suggesting similar lines and identifying context mismatches when edits fail.
- **Match Confidence Scoring**: Resolves ambiguity by ranking candidates based on exactness, context, and Levenshtein distance.
- **Context Validation**: Uses before/after context anchors to ensure correct match location.
- **Automatic Backups**: Timestamped backups with configurable retention policy.
- **Transactional Edits**: `batch_edit` applies all-or-nothing changes across multiple files.
- **Undo/Redo Support**: Full edit history with inverse operations.

### 3. 🧠 Project Intelligence
- **Symbol Search**: AST-based search for classes, functions, methods across the project
- **Dependency Analysis**: Track imports/exports and file relationships
- **Impact Analysis**: Understand transitive dependencies before making changes
- **Module Resolution**: Resolve relative imports to actual file paths
- **Reference Finding**: Find all usages of a symbol across the codebase
- **Documentation Extraction**: Extract JSDoc/TSDoc comments for symbol explanations

### 4. 🔍 Efficient Search
- **Keyword Search**: Fast multi-file search with ignore pattern support
- **Pattern Matching**: Regex-based code search across the codebase
- **Smart Filtering**: Respects `.gitignore` and `.mcpignore` patterns

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   Smart Context MCP Server                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   SCOUT      │───▶│    READ      │───▶│    REPLACE       │  │
│  │   Stage      │    │    Stage     │    │    Stage         │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│         │                   │                     │             │
│         ▼                   ▼                     ▼             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ File Scanner │    │  Interval    │    │  Safety Engine   │  │
│  │ + Symbol     │    │  Merger      │    │  - Uniqueness    │  │
│  │   Index      │    │              │    │  - Fuzzy Match   │  │
│  │              │    │              │    │  - Anchoring     │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Core Components

- **Tree-sitter**: Robust AST parsing for TypeScript, JavaScript, Python
- **fast-levenshtein**: Fuzzy string matching for edit tolerance
- **web-tree-sitter**: WebAssembly-based parser for performance
- **ignore**: `.gitignore` pattern matching for file filtering

## 📦 Installation

### Prerequisites
- Node.js 16+ with TypeScript support
- npm or yarn package manager

### Setup

```bash
# Clone or navigate to the project
cd smart-context-mcp

# Install dependencies
npm install

# Build the project
npm run build

# Run the server (stdio transport)
node dist/index.js /path/to/your/project
```

### MCP Client Configuration

Add to your MCP client configuration (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "node",
      "args": [
        "/absolute/path/to/smart-context-mcp/dist/index.js",
        "/absolute/path/to/your/project"
      ]
    }
  }
}
```

## 🚀 Quick Start

### Example 1: Understanding Code Structure

```javascript
// Get a bird's-eye view of a file (signatures only)
await use_mcp_tool({
  server_name: "smart-context",
  tool_name: "read_file_skeleton",
  arguments: {
    filePath: "src/index.ts",
    format: "text"  // or "json" for structured output
  }
});
```

### Example 2: Focused Reading

```javascript
// Read only relevant sections using keywords
await use_mcp_tool({
  server_name: "smart-context",
  tool_name: "read_fragment",
  arguments: {
    filePath: "src/engine/Editor.ts",
    keywords: ["fuzzy", "match"],
    contextLines: 3  // Include 3 lines of context around matches
  }
});
```

### Example 3: Safe Editing with Context

```javascript
// Edit with fuzzy matching and context validation
await use_mcp_tool({
  server_name: "smart-context",
  tool_name: "edit_file",
  arguments: {
    filePath: "src/utils.ts",
    edits: [{
      targetString: "function processData(input) {\n  return input.trim();",
      replacementString: "function processData(input: string): string {\n  return input.trim();",
      beforeContext: "// Data processing utilities",
      fuzzyMode: "whitespace"  // Tolerate whitespace differences
    }],
    dryRun: false
  }
});
```

### Example 4: Multi-File Refactoring

```javascript
// Atomic batch edit across multiple files
await use_mcp_tool({
  server_name: "smart-context",
  tool_name: "batch_edit",
  arguments: {
    fileEdits: [
      {
        filePath: "src/models/User.ts",
        edits: [{ targetString: "userId", replacementString: "userID" }]
      },
      {
        filePath: "src/services/UserService.ts",
        edits: [{ targetString: "userId", replacementString: "userID" }]
      }
    ],
    dryRun: false
  }
});
```

### Example 5: Finding Symbol Definitions

```javascript
// Search for symbol definitions across the project
await use_mcp_tool({
  server_name: "smart-context",
  tool_name: "search_symbol_definitions",
  arguments: {
    query: "EditorEngine"  // Find classes, functions, methods
  }
});
```

### Example 6: Dependency Analysis

```javascript
// Understand file dependencies
await use_mcp_tool({
  server_name: "smart-context",
  tool_name: "get_file_dependencies",
  arguments: {
    filePath: "src/index.ts",
    direction: "outgoing"  // or "incoming" for reverse dependencies
  }
});

// Assess change impact
await use_mcp_tool({
  server_name: "smart-context",
  tool_name: "analyze_impact",
  arguments: {
    filePath: "src/engine/Editor.ts",
    direction: "incoming",  // Find what depends on this file
    maxDepth: 20
  }
});
```

## 📚 Tool Reference

### File Reading Tools

#### `read_file`
Reads the entire content of a file.

**Parameters:**
- `filePath` (string, required): Path to the file (relative to project root)

**Returns:** Full file content as text

**Use Case:** When you need complete file content (rare in large files)

---

#### `read_file_skeleton`
Returns a skeleton view showing only signatures, not implementation details, and can extract documentation (JSDoc/TSDoc) if available.

**Parameters:**
- `filePath` (string, required): Path to the file
- `format` (string, optional): Output format - `"text"` or `"json"` (default: `"text"`)

**Returns:** 
- `text` format: Code with function/method bodies folded
- `json` format: Structured representation of classes, functions, methods, with optional `documentation` field.

**Use Case:** Understanding code structure and purpose without token waste.

**Example Output (json with documentation):**
```json
{
  "classes": [
    {
      "name": "EditorEngine",
      "methods": ["constructor", "applyEdits", "_fuzzyMatch"],
      "lineRange": { "start": 33, "end": 250 },
      "documentation": {
        "description": "Engine for safely applying code edits.",
        "params": [
          { "name": "rootPath", "type": "string", "description": "Project root." }
        ],
        "returns": null
      }
    }
  ]
}
```

---

#### `read_fragment`
Extracts relevant sections based on keywords, patterns, or line ranges.

**Parameters:**
- `filePath` (string, required): Path to the file
- `keywords` (string[], optional): Keywords to search for
- `patterns` (string[], optional): Regex patterns to match
- `contextLines` (number, optional): Lines of context around matches (default: 0)
- `lineRanges` (array, optional): Specific line ranges to extract `[{ start, end }]`

**Returns:** Merged intervals of matching code regions

**Use Case:** Focused reading of relevant code sections

**Example:**
```javascript
{
  filePath: "src/engine/Editor.ts",
  keywords: ["fuzzy", "levenshtein"],
  contextLines: 5
}
// Returns only sections mentioning fuzzy matching with 5 lines of context
```

---

### Code Intelligence Tools

#### `search_symbol_definitions`
Searches for symbol definitions (classes, functions, methods) using AST parsing.

**Parameters:**
- `query` (string, required): Symbol name to search for

**Returns:** Array of symbol locations with file path, line numbers, and symbol type

**Use Case:** Finding where a class or function is defined

**Example Response:**
```json
[
  {
    "file": "src/engine/Editor.ts",
    "symbolName": "EditorEngine",
    "symbolType": "class",
    "lineNumber": 33
  }
]
```

---

#### `get_file_dependencies`
Analyzes direct file dependencies based on import/export statements.

**Parameters:**
- `filePath` (string, required): Path to the file
- `direction` (string, optional): `"outgoing"` (what this file imports) or `"incoming"` (what imports this file) (default: `"outgoing"`)

**Returns:** List of dependent files with import details

**Use Case:** Understanding file relationships and dependency structure

---

#### `analyze_impact`
Analyzes transitive dependencies to assess the impact of changes.

**Parameters:**
- `filePath` (string, required): Path to the file
- `direction` (string, optional): `"incoming"` or `"outgoing"` (default: `"incoming"`)
- `maxDepth` (number, optional): Maximum traversal depth (default: 20)

**Returns:** Dependency tree showing all transitively affected files

**Use Case:** Understanding blast radius before making changes

---

#### `find_referencing_symbols`
Finds all occurrences where a given symbol is referenced in the codebase.

**Parameters:**
- `name_path` (string, required): Name path of the symbol to find references for (e.g., `"MyClass/myMethod"`)
- `relative_path` (string, required): Path to the file containing the symbol definition

**Returns:** List of referencing locations with file path, line numbers, and code snippet

**Use Case:** Understanding all usages of a specific function, class, or variable.

**Example Response:**
```json
[
  {
    "file": "src/services/UserService.ts",
    "lineNumber": 55,
    "codeSnippet": "const user = new User(data);",
    "symbolName": "User"
  }
]
```

---

### File Writing Tools

#### `write_file`
Creates a new file or completely overwrites an existing file.

**Parameters:**
- `filePath` (string, required): Path to the file
- `content` (string, required): Complete file content

**Returns:** Success confirmation

**Use Case:** Creating new files or complete rewrites

**⚠️ Warning:** This operation is destructive. Use `edit_file` for partial modifications.

---

#### `edit_file`
Safely applies multiple edits to a file with atomic transaction and conflict detection.

**Parameters:**
- `filePath` (string, required): Path to the file
- `edits` (array, required): Array of edit operations
  - `targetString` (string, required): Exact or fuzzy-matched target
  - `replacementString` (string, required): Replacement text
  - `lineRange` (object, optional): Search within `{ start, end }` line range
  - `beforeContext` (string, optional): Anchor text before target
  - `afterContext` (string, optional): Anchor text after target
  - `fuzzyMode` (string, optional): `"whitespace"` or `"levenshtein"`
  - `anchorSearchRange` (object, optional): Context search limits `{ lines, chars }`
- `dryRun` (boolean, optional): Preview changes without applying (default: false)

**Returns:** 
- Success: Applied edits with diff preview
- Failure: Error details with conflicting line numbers

**Use Case:** Surgical code modifications with safety guarantees

**Safety Features:**
- ✅ Automatic backup before editing
- ✅ Fuzzy matching tolerates whitespace differences
- ✅ Context anchors prevent ambiguous matches
- ✅ Atomic transaction (all edits succeed or none apply)
- ✅ Conflict detection with detailed error reporting

**Example:**
```javascript
{
  filePath: "src/utils.ts",
  edits: [{
    targetString: "function calculate(x, y)",
    replacementString: "function calculate(x: number, y: number): number",
    beforeContext: "// Math utilities",
    fuzzyMode: "whitespace"
  }],
  dryRun: false
}
```

---

#### `batch_edit`
Applies edits to multiple files atomically (all-or-nothing transaction).

**Parameters:**
- `fileEdits` (array, required): Array of file edit operations
  - `filePath` (string, required): Path to the file
  - `edits` (array, required): Same format as `edit_file` edits
- `dryRun` (boolean, optional): Preview changes without applying

**Returns:** Success with all applied changes or rollback on any failure

**Use Case:** Multi-file refactoring with transaction guarantees

**Example:**
```javascript
{
  fileEdits: [
    {
      filePath: "src/models/User.ts",
      edits: [{ targetString: "userId", replacementString: "userID" }]
    },
    {
      filePath: "src/services/UserService.ts",
      edits: [{ targetString: "userId", replacementString: "userID" }]
    }
  ]
}
```

---

### History Management Tools


#### `preview_rename`
Previews the impact of renaming a symbol across the codebase without applying changes.

**Parameters:**
- `filePath` (string, required): Path to the file containing the symbol
- `symbolName` (string, required): The current name of the symbol
- `newName` (string, required): The proposed new name for the symbol

**Returns:** A list of potential edits (targetString, replacementString, lineRange) that would be applied.

**Use Case:** Safely planning large-scale symbol renames by reviewing all affected locations.

**⚠️ Warning:** This tool only provides a preview. Actual renaming requires a subsequent `batch_edit` call with the generated edits.

---

#### `undo_last_edit`
Undoes the last successful `edit_file` operation.

**Parameters:** None

**Returns:** Restored file state with undo details

**Use Case:** Reverting recent changes

**Note:** Only works for operations that modified files via `edit_file`

---

#### `redo_last_edit`
Redoes the last undone `edit_file` operation.

**Parameters:** None

**Returns:** Reapplied edits with details

**Use Case:** Reapplying undone changes

---

### Search and Navigation Tools

#### `search_files`
Searches for keywords or patterns across the project.

**Parameters:**
- `keywords` (string[], optional): Keywords to search for
- `patterns` (string[], optional): Regex patterns to match
- `includeGlobs` (string[], optional): File patterns to include (e.g., `["*.ts"]`)
- `excludeGlobs` (string[], optional): File patterns to exclude

**Returns:** Matching files with line numbers and context

**Use Case:** Finding where specific code patterns exist

**Example:**
```javascript
{
  keywords: ["EditorEngine", "fuzzy"],
  includeGlobs: ["src/**/*.ts"],
  excludeGlobs: ["**/*.test.ts"]
}
```

---

#### `list_directory`
Lists directory contents in a tree-like structure.

**Parameters:**
- `path` (string, required): Directory path (relative to project root)
- `depth` (number, optional): Maximum traversal depth (default: 2)

**Returns:** Tree structure respecting `.gitignore` and `.mcpignore`

**Use Case:** Exploring project structure

---

## 🔒 Security Features

### Path Validation
- All file paths are validated against the project root
- Prevents directory traversal attacks
- Blocks access to files outside the allowed directory

### Automatic Backups
- Timestamped backups created before any edit
- Stored in `.mcp/backups/` directory
- Configurable retention policy (default: 10 backups per file)
- Easy restore from backup if needed

### Atomic Operations
- Edit operations are transactional
- Partial failures are automatically rolled back
- File integrity is maintained even on errors

## 🎛️ Configuration

### Ignore Patterns

Create a `.mcpignore` file in your project root to exclude files from scanning:

```
# Dependencies
node_modules/
vendor/

# Build outputs
dist/
build/
*.min.js

# Test files
**/*.test.ts
coverage/
```

**Note:** The server automatically respects `.gitignore` patterns as well.

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Build before testing
npm run build && npm test
```

**Test Coverage:**
- Unit tests for all core engines
- Integration tests for edit operations
- Performance benchmarks for search and edit
- AST parsing and symbol resolution tests

---

## 🏗️ Development

### Project Structure

```
smart-context-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── types.ts              # Shared type definitions
│   ├── engine/               # Core engines
│   │   ├── Context.ts        # Fragment extraction & interval merging
│   │   ├── Editor.ts         # Safe atomic editing with fuzzy matching
│   │   ├── EditCoordinator.ts # Batch edit orchestration
│   │   ├── History.ts        # Undo/redo management
│   │   ├── Search.ts         # File and pattern search
│   │   ├── Ranking.ts        # Search result ranking
│   │   ├── Diff.ts           # Myers diff algorithm
│   │   └── LineCounter.ts    # Efficient line number tracking
│   ├── ast/                  # AST-based analysis
│   │   ├── AstManager.ts     # Tree-sitter parser management
│   │   ├── SkeletonGenerator.ts # Code outline generation
│   │   ├── SymbolIndex.ts    # Symbol definition indexing
│   │   ├── ModuleResolver.ts # Import path resolution
│   │   └── DependencyGraph.ts # Dependency tracking
│   └── tests/                # Test suites
├── dist/                     # Compiled JavaScript output
├── docs/                     # Architecture decision records
└── .mcp/                     # Runtime data (backups, history)
```

### Key Technologies

- **TypeScript 5.3+**: Type-safe development
- **Tree-sitter**: Fast, robust AST parsing
- **Web Assembly**: High-performance parser runtime
- **MCP SDK**: Model Context Protocol implementation
- **Jest**: Testing framework

---

## 📖 Documentation

Detailed architecture documentation available in the `docs/` directory:

- **ADR-001**: Smart Context Architecture
- **ADR-002**: Smart Engine Refactoring
- **ADR-003**: Advanced Algorithms
- **ADR-004**: Agent-Driven Refactoring
- **ADR-005**: Reliability and Transactions
- **ADR-008**: Pragmatic Reliability Enhancements
- **ADR-009**: Editor Engine Improvements
- **ADR-010**: Smart Semantic Analysis
- **ADR-011**: Robustness and Advanced Analysis
- **ADR-012**: Project Intelligence
- **ADR-013**: Serena Feature Analysis


---

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass (`npm test`)
5. Submit a pull request

### Code Style
- Use TypeScript strict mode
- Follow existing naming conventions
- Add JSDoc comments for public APIs
- Keep functions focused and testable

---

## 📄 License

ISC License - see LICENSE file for details

---

## 🙏 Acknowledgments

Built with:
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol) by Anthropic
- [Tree-sitter](https://tree-sitter.github.io/) for AST parsing
- [fast-levenshtein](https://github.com/hiddentao/fast-levenshtein) for fuzzy matching
- [ignore](https://github.com/kaelzhang/node-ignore) for gitignore pattern matching

---

## 📞 Support

For issues, questions, or feature requests, please use the GitHub issue tracker.

---

**Version:** 2.2.0  
**Last Updated:** December 2024
