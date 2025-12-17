# ADR-004: Agent-Driven Refactoring for Enhanced Safety, Accuracy, and Performance

## 1. Context

`IMPROVEMENT-NOTES-smart-context-mcp.md` 문서와 외부 리뷰를 통해 현재 `smart-context-mcp`의 강점과 개선점이 명확해졌다. ADR-003까지의 구현으로 핵심 기능(검색, 분석, 편집)의 기반은 마련되었으나, LLM 에이전트가 더 안정적이고 효율적으로 사용하기 위해서는 몇 가지 구조적 개선이 필요하다. 이 문서는 안전성, 정확도, 성능이라는 세 가지 축을 중심으로 핵심 리팩토링 방향을 결정한다.

## 2. Decision: 통합된 개선 로드맵 (신뢰도 강화)

`smart-context-mcp`의 다음 단계는 **"신뢰도 강화"**에 집중한다. 다음 우선순위에 따라 리팩토링을 진행하여 서버의 안정성, 정확도, 성능 및 에이전트 친화성을 극대화한다.

---

### **P1: 보안 및 안정성 강화 (Security & Stability)**

1.  **루트 샌드박스 구현**: `SmartContextServer` 생성 시 `rootPath`를 필수 인자로 받는다. 모든 파일 기반 도구(`read_file`, `edit_file` 등)는 `path.resolve`를 통해 얻은 절대 경로가 이 `rootPath` 내에 포함되는지 검증한다. 경로가 벗어날 경우, MCP 표준에 따라 `isError: true`와 함께 구조화된 에러(`{ "errorCode": "SecurityViolation", "message": "File path is outside the allowed root directory." }`)를 반환한다.
2.  **`.gitignore` 통합**: `SearchEngine`과 `ContextEngine`에 `ignore` 라이브러리를 활용한 필터링 로직을 추가한다. 서버 초기화 시 `rootPath`에서 `.gitignore`와 `.mcpignore` 파일을 읽어 필터링 규칙을 메모리에 로드한다. `runGrep`과 `listDirectoryTree`는 이 규칙을 기본으로 적용하여 불필요한 파일(e.g., `node_modules`, `build`, `dist`)을 사전에 제외시킨다.
3.  **Windows 호환성 확보**: `grep` 대신 `rg` (ripgrep) 사용을 우선하고, Windows 환경에서 경로 처리(`\` vs `/`) 및 셸 명령어 호환성(PowerShell/WSL)을 고려한 구현 및 테스트를 포함한다.

---

### **P2: 에이전트 신뢰도 향상 (Agent Reliability)**

1.  **표준화된 에러 응답 스키마 정의**: 모든 툴 응답은 `isError: boolean` 필드를 포함하며, 에러 발생 시 `content` 필드에 `{\"errorCode\": string, \"message\": string, \"suggestion\"?: string}` 형태의 구조화된 에러 정보를 담도록 통일한다. 이는 LLM 에이전트의 안정적인 에러 처리 및 복구 전략 수립을 돕는다.
2.  **구체적인 에러 복구 힌트 제공**: `edit_file` 실패 시 `\"suggestion\": \"라인 45~50으로 범위를 좁혀 anchor.beforeContext를 지정하세요\"`와 같이 LLM 에이전트가 재시도 전략을 쉽게 만들 수 있는 구체적인 힌트를 포함한다.
3.  **타입 정의 통합**: `src/types.ts`를 단일 진실 소스로 유지하고, `Ranking.ts` 등에서 재정의되는 인터페이스를 모두 import 방식으로 통일하여 유지보수성을 높인다.

---

### **P3: 핵심 기능 고도화 (Core Feature Refinement)**

1.  **Localized Anchoring**: `EditorEngine.findMatch` 메서드를 수정하여 `beforeContext` 및 `afterContext` 검색 범위를 제한한다. `anchorSearchRange: { lines?: number, chars?: number }` 파라미터를 `edit` 객체에 추가하여, 컨텍스트 검색을 "매치 후보 주변 ±N줄/±M자"로 국소화한다.
2.  **Fuzzy Matching Expansion**: `edit` 객체의 `fuzzyMatch: boolean`을 `fuzzyMode: "whitespace" | "levenshtein"`으로 대체한다.
    *   `whitespace`: 기존처럼 공백 차이를 무시하는 정규식을 사용한다. (기본값)
    *   `levenshtein`: `fast-levenshtein`과 같은 경량 라이브러리를 사용하여, 지정된 편집 거리(e.g., `maxDistance: 2`) 내의 가장 유사한 문자열을 찾는다. (현재 미구현 상태임을 인지하고, 향후 P3 또는 P4 단계에서 구현)

---

### **P4: 품질 보증 체계 구축 (Quality Assurance)**

1.  **성능 벤치마크 기준 수립**: 개선 작업 착수 전, `search_files`가 1만 개 파일 대상 실행 시 N초, `edit_file`이 10MB 파일 수정 시 M초 등 핵심 유저 시나리오에 대한 성능 기준을 수립한다. 이는 향후 최적화 작업의 성공 여부를 측정하는 기준이 된다.
2.  **테스트 전략 구체화**: 단위 테스트 외에 실제 코드베이스(예: 소규모 오픈소스 라이브러리)를 대상으로 한 End-to-End 테스트 시나리오를 추가한다. 테스트 커버리지 목표(예: `85%`)를 설정하고, 특히 Windows 환경에서의 호환성 테스트를 필수적으로 포함한다.
3.  **동적 토큰 예산 관리**: `read_fragment`와 같은 툴이 LLM의 토큰 예산을 초과하는 컨텍스트를 반환하지 않도록, `maxTokens`와 같은 파라미터를 추가하여 응답 길이를 동적으로 조절하는 방안을 고려한다.

---

### **P5: 장기 과제 (Future Enhancements)**

1.  **고수준 조합 툴 제공**: `smart_search_and_read`와 같은 고수준 툴(내부적으로 `search_files` + `ranking` + `read_fragment`를 결합)을 실험적으로 도입하여 에이전트의 플랜 복잡성을 줄이고 작업 흐름을 간소화한다. 단, MCP의 "composability" 원칙과 트레이드오프가 있으므로, 기존 툴이 안정화된 후 실험적으로 도입 검토.
2.  **알고리즘 확장**:
    *   **Diff 대안 (선택적)**: Myers가 기본인 상태는 유지하되, 대형 파일에서 성능 이슈가 보이면 Patience diff 또는 `diff-match-patch` 기반의 fallback 모드를 고려한다. `dryRun` 응답에서 unified diff + 구조화 JSON(`[{ type, path, before, after }]`)를 병행하면 UI/에이전트 모두 활용도가 올라간다.
    *   **Ranking 피처 강화**: BM25 점수 계산 전에 파일명/경로 패턴, export 여부, 테스트 파일 여부 등 구조적 신호를 가중치로 더해 실제 사용 시 체감 품질을 높인다. 향후 필요시 "BM25 → 상위 N개 → 경량 임베딩 재정렬" 2단계 랭킹을 옵션으로 추가할 수 있다.
    *   **Fuzzy 매칭 고도화**: 공백 유연 Regex 이외에 `mode: "whitespace" | "token_levenshtein"`을 제공하여, 토큰 단위 레벤슈타인을 사용하는 선택지를 마련한다. normalize 단계에서 snake/camel case 분해, lower-case 변환 등을 적용하면 매칭 성공률이 더 높아진다.
    *   **검색 파이프라인 통합**: 장기적으로 `read_fragment`가 내부적으로 `search_files` 결과를 받아 병합/추출하는 "파이프라인 툴"을 제공하면 에이전트가 덜 복잡한 플랜으로 동일 목표를 달성할 수 있다.
3.  **라인 기반을 보완하는 anchoring 전략**: byte offset 기반 anchoring 또는 AST/구조 기반 anchoring (예: 함수/블록 단위) 도입을 고려한다.

## 3. Design Details (각 개선 영역에 대한 구체적인 설계)

### 3.1. Safety-First Sandbox Implementation
(기존 내용과 동일)
- **Root Path Enforcement**:
  - `SmartContextServer` 생성 시 `rootPath`를 필수 인자로 받는다. 모든 파일 기반 도구(`read_file`, `edit_file` 등)는 `path.resolve`를 통해 얻은 절대 경로가 이 `rootPath` 내에 포함되는지 검증한다.
  - 경로가 벗어날 경우, MCP 표준에 따라 `isError: true`와 함께 구조화된 에러(`{ "errorCode": "SecurityViolation", "message": "File path is outside the allowed root directory." }`)를 반환한다.
- **`.gitignore` Integration**:
  - `SearchEngine`과 `ContextEngine`에 `ignore` 라이브러리를 활용한 필터링 로직을 추가한다.
  - 서버 초기화 시 `rootPath`에서 `.gitignore`와 `.mcpignore` 파일을 읽어 필터링 규칙을 메모리에 로드한다.
  - `runGrep`과 `listDirectoryTree`는 이 규칙을 기본으로 적용하여 불필요한 파일(e.g., `node_modules`, `build`, `dist`)을 사전에 제외시킨다.

### 3.2. Accuracy-Enhanced Editing Logic
(기존 내용과 동일)
- **Localized Anchoring**:
  - `EditorEngine.findMatch` 메서드를 수정하여 `beforeContext` 및 `afterContext` 검색 범위를 제한한다.
  - `anchorSearchRange: { lines?: number, chars?: number }` 파라미터를 `edit` 객체에 추가하여, 컨텍스트 검색을 "매치 후보 주변 ±N줄/±M자"로 국소화한다. 이를 통해 큰 파일에서의 성능 저하와 의도치 않은 매칭 오류를 방지한다.
- **Fuzzy Matching Expansion**:
  - `edit` 객체의 `fuzzyMatch: boolean`을 `fuzzyMode: "whitespace" | "levenshtein"`으로 대체한다.
  - `whitespace`: 기존처럼 공백 차이를 무시하는 정규식을 사용한다. (기본값)
  - `levenshtein`: `fast-levenshtein`과 같은 경량 라이브러리를 사용하여, 지정된 편집 거리(e.g., `maxDistance: 2`) 내의 가장 유사한 문자열을 찾는다. 이 모드는 `anchorSearchRange`가 작게 지정된 경우에만 활성화하여 성능 저하를 최소화한다.

### 3.3. Performance-Tuned Backend Architecture
(기존 내용과 동일)
- **Flexible Search Backend**:
  - `SearchEngine` 내에 `ISearchProvider` 인터페이스(`(pattern, options) => Promise<FileMatch[]>`)를 정의한다.
  - `GrepSearchProvider`와 `RipgrepSearchProvider` 클래스를 각각 구현한다.
  - `SearchEngine` 생성 시, `child_process.execSync('which rg')` 등을 통해 `rg` (ripgrep)의 존재 여부를 확인하고, 사용 가능한 최적의 프로바이더를 동적으로 선택한다. `rg`가 없을 경우 `grep`으로 안전하게 폴백한다.
- **Standardized Search Response**:
  - `SearchEngine.scout`의 반환 타입을 `Promise<FileMatch[]>`에서 `Promise<{ matches: FileMatch[], truncated: boolean, errors: string[] }>`으로 변경한다.
  - `truncated`: 검색 결과가 너무 많아 일부가 잘렸는지 여부를 나타낸다.
  - `errors`: 일부 디렉터리 접근 권한 없음 등 검색 중 발생한 비치명적 오류 목록을 포함한다.
  - 이 구조화된 응답은 `index.ts`의 `search_files` 핸들러에서 최종적으로 LLM 에이전트에게 전달된다.

## 4. Architectural Consequences
(기존 내용과 동일)
- **향상된 안정성**: 샌드박스 도입으로 인해 에이전트가 의도치 않게 시스템의 다른 부분을 수정하거나 민감한 파일에 접근할 위험이 사라진다.
- **줄어든 재시도**: 편집 정확도 개선으로 `edit_file`의 성공률이 높아져, 에이전트가 같은 작업을 여러 번 시도하며 발생하는 토큰 및 시간 낭비가 줄어든다.
- **개선된 성능 및 휴대성**: `ripgrep` 지원으로 대규모 리포지토리에서도 빠른 검색이 가능해지며, `grep` 폴백 덕분에 다양한 환경에서의 호환성이 유지된다.
- **명확해진 책임**: 각 엔진(`Search`, `Editor`)의 역할이 더 명확해지며, `ISearchProvider`와 같은 인터페이스 도입으로 향후 새로운 검색 도구(e.g., `git grep`)를 추가하기 용이해진다.
- **복잡성 증가**: `SearchEngine` 내 프로바이더 선택 로직, `EditorEngine`의 국소 앵커링 계산 등 내부 로직의 복잡성은 다소 증가한다. 이를 완화하기 위해 각 기능에 대한 단위 테스트를 철저히 작성해야 한다.

## 5. Next Steps

1.  **P1 (보안 및 안정성)**:
    *   `SmartContextServer`에 `rootPath` 검증 로직을 추가하고, `ignore` 라이브러리를 `package.json`에 추가하여 `.gitignore` 기반 필터링을 구현한다.
    *   Windows 환경에서의 호환성을 위한 초기 설계 및 테스트 방안을 마련한다.
2.  **P2 (에이전트 신뢰도)**:
    *   `src/types.ts`에 `ISearchProvider` 인터페이스와 새로운 `scout` 응답 타입을 정의하고, 타입 정의 중복을 제거한다.
    *   모든 툴의 에러 응답이 표준화된 스키마를 따르도록 `index.ts` 핸들러를 수정하고, 구체적인 에러 힌트를 추가하는 방안을 고려한다.
3.  **P3 (핵심 기능 고도화)**:
    *   `EditorEngine`의 `findMatch`를 수정하여 국소 앵커링을 구현한다.
    4.  `SearchEngine`을 리팩토링하여 `GrepSearchProvider`와 `RipgrepSearchProvider`를 구현하고, 동적 선택 로직을 추가한다.
5.  **P4 (품질 보증)**:
    *   `search_files` 및 `edit_file`의 핵심 시나리오에 대한 성능 벤치마크 기준을 수립한다.
    *   각 변경 사항에 맞춰 `read_file_regions.test.ts`, `replace_in_file.test.ts`, `scout_files.test.ts`를 포함한 모든 단위 테스트를 업데이트하고 통과시킨다.
    *   E2E 및 회귀 테스트 시나리오를 구상하고, 테스트 커버리지 목표를 설정한다.
6.  **P5 (장기 과제)**:
    *   Levenshtein 기반 퍼지 매칭, 고수준 조합 툴, 알고리즘 확장 등 장기 과제에 대한 추가 연구 및 설계 문서를 준비한다.
