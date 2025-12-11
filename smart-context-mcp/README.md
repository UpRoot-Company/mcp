# Smart Context MCP Server

대규모 코드베이스에 LLM이 효율적이고 안전하며 지능적으로 접근할 수 있도록 설계된 MCP(Model Context Protocol) 서버입니다. "Scout → Read → Replace" 파이프라인을 기반으로, 토큰 사용량을 최소화하면서 코드 이해와 편집 안전성을 극대화합니다.

[![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

## 🎯 Overview

Smart Context MCP는 AI 에이전트가 코드베이스를 효과적으로 탐색하고 수정할 수 있도록 5가지 Intent 기반 도구를 제공합니다:

| Tool | Purpose |
|------|---------|
| `read_code` | 파일 읽기 (전체/스켈레톤/프래그먼트) |
| `search_project` | 파일, 심볼, 디렉토리 통합 검색 |
| `analyze_relationship` | 의존성, 콜그래프, 타입, 데이터 플로우 분석 |
| `edit_code` | 원자적 코드 편집 (생성/삭제/교체) |
| `manage_project` | 프로젝트 관리 (undo/redo/상태/가이던스) |

### 핵심 기능

- **🔍 클러스터 기반 검색**: 심볼 간 관계를 고려한 지능형 검색
- **🌳 AST 기반 분석**: Tree-sitter를 활용한 콜그래프, 타입 계층, 데이터 플로우 추적
- **✏️ 원자적 편집**: 트랜잭션 안전성과 자동 롤백을 지원하는 멀티파일 편집
- **📊 Smart File Profile**: 파일 메타데이터, 구조, 의존성 정보를 통합 제공
- **♻️ Undo/Redo**: 편집 이력 관리 및 복구 지원

---

## 🚀 Quick Start

### Installation

```bash
npm install smart-context-mcp
```

### Claude Desktop Configuration

`claude_desktop_config.json`에 다음을 추가하세요:

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["smart-context-mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### 환경 변수

| Variable | Description | Default |
|----------|-------------|---------|
| `SMART_CONTEXT_DEBUG` | 디버그 로그 활성화 | `false` |
| `SMART_CONTEXT_DISABLE_PRECOMPUTE` | 클러스터 사전 계산 비활성화 | `false` |
| `SMART_CONTEXT_ENGINE_MODE` | 엔진 모드 (`prod`/`ci`/`test`) | `prod` |
| `SMART_CONTEXT_PARSER_BACKEND` | 파서 백엔드 (`wasm`/`js`/`snapshot`/`auto`) | `auto` |

---

## 📚 Tool Reference

Smart Context는 ADR-020 워크플로우를 커버하는 5개의 Intent 기반 도구를 제공합니다.

### `read_code`

파일을 세 가지 뷰 모드로 읽어옵니다.

**Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | ✅ | 프로젝트 루트 기준 상대 경로 |
| `view` | `"full"` \| `"skeleton"` \| `"fragment"` | | 뷰 모드 (기본값: `"full"`) |
| `lineRange` | string | `view="fragment"` 시 필수 | 라인 범위 (예: `"10-50"`) |

**Returns**
```typescript
{
  content: string;        // 요청한 뷰의 컨텐츠
  metadata: {
    lines: number;        // 총 라인 수
    language: string;     // 파일 언어
    path: string;         // 파일 경로
  };
  truncated: boolean;     // 1MB 초과 시 true
}
```

**Example**
```json
{
  "filePath": "src/engine/Editor.ts",
  "view": "skeleton"
}
```

---

### `search_project`

파일, 심볼, 디렉토리를 통합 검색합니다. 클러스터 기반 랭킹으로 관련성 높은 결과를 제공합니다.

**Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✅ | 검색 쿼리 (자연어, 심볼명, glob 패턴) |
| `type` | `"auto"` \| `"file"` \| `"symbol"` \| `"directory"` | | 검색 타입 (기본값: `"auto"`) |
| `maxResults` | number | | 최대 결과 수 (기본값: 20) |

**Returns**
```typescript
{
  results: Array<{
    type: "file" | "symbol" | "directory";
    path: string;
    score: number;        // 0-1 관련성 점수
    context?: string;     // 미리보기 또는 요약
    line?: number;        // 심볼의 라인 번호
  }>;
  inferredType?: string;  // auto 모드에서 추론된 타입
}
```

**Example**
```json
{
  "query": "EditorEngine fuzzy matching",
  "type": "auto",
  "maxResults": 10
}
```

---

### `analyze_relationship`

파일이나 심볼의 관계를 다양한 모드로 분석합니다.

**Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | ✅ | 파일 경로 또는 심볼명 |
| `targetType` | `"auto"` \| `"file"` \| `"symbol"` | | 타겟 타입 (기본값: `"auto"`) |
| `contextPath` | string | | 심볼 구분을 위한 파일 경로 |
| `mode` | `"impact"` \| `"dependencies"` \| `"calls"` \| `"data_flow"` \| `"types"` | ✅ | 분석 모드 |
| `direction` | `"upstream"` \| `"downstream"` \| `"both"` | | 분석 방향 (기본값: `"both"`) |
| `maxDepth` | number | | 탐색 깊이 (모드별 기본값 상이) |
| `fromLine` | number | | `data_flow` 모드용 시작 라인 |

**Analysis Modes**
| Mode | Description | Use Case |
|------|-------------|----------|
| `impact` | 변경 영향 범위 분석 | 리팩토링 전 영향도 파악 |
| `dependencies` | 파일 간 import/export 관계 | 모듈 구조 이해 |
| `calls` | 함수 콜그래프 | 함수 호출 흐름 추적 |
| `data_flow` | 변수 데이터 플로우 | 변수 전파 경로 추적 |
| `types` | 타입 계층 관계 | 상속/구현 관계 분석 |

**Example**
```json
{
  "target": "EditorEngine",
  "contextPath": "src/engine/Editor.ts",
  "mode": "calls",
  "direction": "downstream",
  "maxDepth": 2
}
```

---

### `edit_code`

원자적 편집 연산을 지원하는 트랜잭션 기반 에디터입니다.

**Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `edits` | array | ✅ | 편집 연산 배열 |
| `dryRun` | boolean | | 검증만 수행 (기본값: `false`) |
| `createMissingDirectories` | boolean | | 누락된 디렉토리 생성 (기본값: `false`) |
| `ignoreMistakes` | boolean | | 유연한 매칭 모드 활성화 (기본값: `false`) |

**Edit Operations**
```typescript
{
  filePath: string;                    // 대상 파일 경로
  operation: "replace" | "create" | "delete";
  targetString?: string;               // replace 시 필수
  replacementString?: string;          // replace/create 시 필수
  lineRange?: { start: number; end: number };
  beforeContext?: string;              // 매칭 힌트
  afterContext?: string;               // 매칭 힌트
  fuzzyMode?: "whitespace" | "levenshtein";
  normalization?: "exact" | "whitespace" | "structural";
  expectedHash?: { algorithm: string; value: string };
}
```

**Example**
```json
{
  "dryRun": true,
  "edits": [
    {
      "filePath": "src/engine/Search.ts",
      "operation": "replace",
      "targetString": "const DEFAULT_LIMIT = 50;",
      "replacementString": "const DEFAULT_LIMIT = 100;",
      "fuzzyMode": "whitespace"
    },
    {
      "filePath": "src/utils/helper.ts",
      "operation": "create",
      "replacementString": "export function helper() {\n  return true;\n}"
    }
  ]
}
```

---

### `manage_project`

프로젝트 수준의 명령을 실행합니다.

**Parameters**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `"undo"` \| `"redo"` \| `"guidance"` \| `"status"` | ✅ | 실행할 명령 |

**Commands**
| Command | Description |
|---------|-------------|
| `undo` | 마지막 편집 취소 |
| `redo` | 취소한 편집 재적용 |
| `guidance` | 에이전트 워크플로우 가이드 반환 |
| `status` | 인덱스 상태 및 프로젝트 정보 |

**Example**
```json
{
  "command": "status"
}
```

---

## 🔄 Agent Workflow

효과적인 코드 수정을 위한 권장 워크플로우입니다.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agent Workflow Pipeline                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Scout & Discover        search_project                      │
│     └─ 관련 파일/심볼 탐색    query: "feature keyword"           │
│                                                                  │
│  2. Profile & Understand    read_code                           │
│     └─ 구조 파악             view: "skeleton"                    │
│                                                                  │
│  3. Fragment & Detail       read_code                           │
│     └─ 상세 코드 확인        view: "fragment", lineRange         │
│                                                                  │
│  4. Impact Analysis         analyze_relationship                │
│     └─ 변경 영향 분석        mode: "impact" | "calls"            │
│                                                                  │
│  5. Edit & Modify           edit_code                           │
│     └─ 코드 수정 (dry-run)   dryRun: true → false               │
│                                                                  │
│  6. Validate & Verify       read_code + manage_project          │
│     └─ 검증 및 테스트        view: "skeleton", command: "status" │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 에러 복구 가이드

| Error | 원인 | 해결 방법 |
|-------|------|----------|
| `NO_MATCH` | 타겟 문자열을 찾을 수 없음 | `read_code(view="fragment")`로 확인 후 `lineRange` 조정 또는 `ignoreMistakes` 활성화 |
| `AMBIGUOUS_MATCH` | 여러 매칭 발견 | `read_code(view="skeleton")`으로 구분 후 `lineRange` 또는 context 추가 |
| `FileSystemError` | 파일 접근 불가 | `search_project`로 경로 확인, 프로젝트 루트 내 파일인지 검증 |

---

## 🏗️ Architecture

### Project Structure

```
smart-context-mcp/
├── src/
│   ├── index.ts                  # MCP 서버 진입점 및 도구 핸들러
│   ├── types.ts                  # 공유 타입 정의
│   │
│   ├── engine/                   # 핵심 엔진 모듈
│   │   ├── Search.ts             # 파일/패턴 검색
│   │   ├── Context.ts            # 프래그먼트 추출, 인터벌 병합
│   │   ├── Editor.ts             # Fuzzy 매칭 기반 원자적 편집
│   │   ├── EditCoordinator.ts    # 배치 편집 오케스트레이션
│   │   ├── History.ts            # Undo/Redo 관리
│   │   ├── Ranking.ts            # 검색 결과 랭킹
│   │   ├── Diff.ts               # Myers diff 알고리즘
│   │   ├── LineCounter.ts        # 라인 번호 추적
│   │   ├── FileProfiler.ts       # 파일 메타데이터 분석
│   │   ├── AgentPlaybook.ts      # 에이전트 워크플로우 가이던스
│   │   └── ClusterSearch/        # 클러스터 기반 검색 엔진
│   │       ├── index.ts          # ClusterSearchEngine
│   │       ├── ClusterBuilder.ts # 클러스터 구축
│   │       ├── ClusterCache.ts   # 클러스터 캐시
│   │       ├── ClusterRanker.ts  # 클러스터 랭킹
│   │       ├── QueryParser.ts    # 쿼리 분석
│   │       ├── SeedFinder.ts     # 시드 심볼 탐색
│   │       ├── HotSpotDetector.ts # 핫스팟 감지
│   │       └── PreviewGenerator.ts # 미리보기 생성
│   │
│   ├── ast/                      # AST 기반 분석 모듈
│   │   ├── AstManager.ts         # Tree-sitter 파서 관리
│   │   ├── AstBackend.ts         # AST 백엔드 인터페이스
│   │   ├── WebTreeSitterBackend.ts # WASM 기반 파서
│   │   ├── JsAstBackend.ts       # JS 기반 파서 (테스트용)
│   │   ├── SnapshotBackend.ts    # 스냅샷 기반 파서
│   │   ├── SkeletonGenerator.ts  # 코드 스켈레톤 생성
│   │   ├── SymbolIndex.ts        # 심볼 정의 인덱싱
│   │   ├── ModuleResolver.ts     # Import 경로 해석
│   │   ├── DependencyGraph.ts    # 의존성 그래프
│   │   ├── ReferenceFinder.ts    # 참조 탐색
│   │   ├── CallGraphBuilder.ts   # 콜그래프 구축
│   │   ├── TypeDependencyTracker.ts # 타입 계층 분석
│   │   └── DataFlowTracer.ts     # 데이터 플로우 추적
│   │
│   └── tests/                    # 테스트 스위트
│
├── docs/                         # 아키텍처 문서 (ADR)
├── coverage/                     # 테스트 커버리지 리포트
└── dist/                         # 컴파일된 JavaScript
```

### Core Components

```
┌─────────────────────────────────────────────────────────────────┐
│                     SmartContextServer                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Intent Tools                            │  │
│  │  read_code | search_project | analyze_relationship        │  │
│  │  edit_code | manage_project                                │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│  ┌───────────────────────────┼───────────────────────────────┐  │
│  │                     Engine Layer                           │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐  │  │
│  │  │ Search  │ │ Context │ │ Editor  │ │ EditCoordinator │  │  │
│  │  │ Engine  │ │ Engine  │ │ Engine  │ │                 │  │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────────────┘  │  │
│  │  ┌─────────┐ ┌─────────┐ ┌──────────────────────────────┐ │  │
│  │  │ History │ │FileProf │ │    ClusterSearchEngine       │ │  │
│  │  │ Engine  │ │  iler   │ │ (Builder|Ranker|Cache|...)  │ │  │
│  │  └─────────┘ └─────────┘ └──────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│  ┌───────────────────────────┼───────────────────────────────┐  │
│  │                      AST Layer                             │  │
│  │  ┌───────────┐ ┌───────────────┐ ┌────────────────────┐   │  │
│  │  │AstManager │ │SkeletonGen    │ │    SymbolIndex     │   │  │
│  │  │(TreeSitter│ │               │ │                    │   │  │
│  │  └───────────┘ └───────────────┘ └────────────────────┘   │  │
│  │  ┌───────────┐ ┌───────────────┐ ┌────────────────────┐   │  │
│  │  │Module     │ │Dependency     │ │   CallGraphBuilder │   │  │
│  │  │Resolver   │ │Graph          │ │   DataFlowTracer   │   │  │
│  │  └───────────┘ └───────────────┘ └────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Technologies

- **TypeScript 5.3+**: 타입 안전한 개발
- **Tree-sitter + WASM**: 고성능 AST 파싱
- **MCP SDK**: Model Context Protocol 구현
- **Jest**: 테스트 프레임워크

---

## 🔒 Security Features

### Path Validation
- 모든 파일 경로는 프로젝트 루트에 대해 검증됩니다
- 디렉토리 탐색 공격 방지
- 허용된 디렉토리 외부 파일 접근 차단

### Atomic Operations
- 편집 연산은 트랜잭션으로 처리됩니다
- 부분 실패 시 자동 롤백
- 오류 발생 시에도 파일 무결성 유지

### Ignore Patterns

`.mcpignore` 파일로 스캔에서 제외할 파일을 설정하세요:

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

> **Note:** 서버는 `.gitignore` 패턴도 자동으로 존중합니다.

---

## 🧪 Testing

```bash
# 모든 테스트 실행
npm test

# 커버리지와 함께 테스트 실행
npm run test:coverage

# 빌드 후 테스트
npm run build && npm test
```

---

## 📖 Documentation

`docs/` 디렉토리에서 상세한 아키텍처 문서를 확인할 수 있습니다:

| ADR | Title | Description |
|-----|-------|-------------|
| ADR-001 | Smart Context Architecture | 기본 아키텍처 설계 |
| ADR-002 | Smart Engine Refactoring | 엔진 리팩토링 |
| ADR-003 | Advanced Algorithms | 고급 알고리즘 |
| ADR-005 | Reliability and Transactions | 신뢰성 및 트랜잭션 |
| ADR-008 | Pragmatic Reliability | 실용적 신뢰성 개선 |
| ADR-009 | Editor Engine Improvements | 편집 엔진 개선 |
| ADR-010 | Smart Semantic Analysis | 시맨틱 분석 |
| ADR-011 | Robustness and Advanced Analysis | 견고성 및 고급 분석 |
| ADR-012 | Project Intelligence | 프로젝트 인텔리전스 |
| ADR-014 | Smart File Profile | 스마트 파일 프로필 |
| ADR-016 | Impact Flow Analysis | 영향 흐름 분석 |
| ADR-017 | Context-Aware Clustered Search | 컨텍스트 인식 클러스터 검색 |
| ADR-020 | Toolset Consolidation | 도구 통합 전략 |

---

## 🤝 Contributing

기여를 환영합니다! 다음 가이드라인을 따라주세요:

1. 레포지토리를 Fork 합니다
2. Feature 브랜치를 생성합니다
3. 새로운 기능에 대한 테스트를 추가합니다
4. 모든 테스트가 통과하는지 확인합니다 (`npm test`)
5. Pull Request를 제출합니다

### Code Style
- TypeScript strict 모드 사용
- 기존 네이밍 컨벤션 준수
- 공개 API에 JSDoc 주석 추가
- 함수를 집중적이고 테스트 가능하게 유지

---

## 📄 License

MIT License - LICENSE 파일 참조

---

## 🙏 Acknowledgments

Built with:
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol) by Anthropic
- [Tree-sitter](https://tree-sitter.github.io/) for AST parsing
- [fast-levenshtein](https://github.com/hiddentao/fast-levenshtein) for fuzzy matching
- [ignore](https://github.com/kaelzhang/node-ignore) for gitignore pattern matching

---

**Version:** 3.0.0  
**Last Updated:** December 2025
