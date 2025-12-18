# ADR-030: Agent-Centric Adaptive Intelligence and Resilience

**Status:** Proposed
**Date:** 2025-12-18
**Author:** Gemini Orchestrator & devkwan
**Related:** ADR-029 (System Maturity Enhancements)

---

## 1. Executive Summary

### Problem Statement
`ADR-029`를 통해 시스템의 성능과 구조적 기틀은 마련되었으나, AI 에이전트가 실제 복잡한 작업을 수행할 때 여전히 다음과 같은 **"인지적 한계"**에 직면합니다.

1.  **구현부 맹점 (Implementation Blindness)**: `skeleton` 뷰는 토큰을 아껴주지만, 함수의 "부수 효과(Side-effects)"를 알기 위해 결국 `full` 뷰를 읽어야 하는 상황이 발생함.
2.  **편집 리스크 (Editing Blindness)**: `dryRun`이 구문 오류만 체크할 뿐, 이 수정이 시스템 전체의 의존성 그래프에 미칠 "논리적 파괴력"을 경고하지 못함.
3.  **맥락 단절 (Context Disruption)**: 파일이 삭제되거나 문법 에러로 파싱이 불가능한 "Broken State"에서 에이전트의 추론 능력이 급격히 저하됨.

### Proposed Solution
에이전트의 "생존"과 "직관"을 보조하는 3대 지능형 기능을 도입합니다.

1.  **Semantic Skeleton Summary**: 숨겨진 구현부 내의 핵심 호출 및 참조를 요약 제공.
2.  **Predictive Impact DryRun**: 편집 적용 전 잠재적 영향도와 리스크 스코어 산출.
3.  **Ghost Interface Archeology**: 유실되거나 깨진 파일의 형태를 주변 흔적(Call-sites)으로 역복원.

---

## 2. Proposed Enhancements

### 🟢 Feature 1: Semantic Skeleton Summary (투시형 스켈레톤)
구현부를 가릴 때, 단순히 생략하는 것이 아니라 그 안에 담긴 **"의미적 지문"**을 남깁니다.

*   **구현**: `SkeletonGenerator`가 구현 블록을 폴딩할 때, 해당 블록 내부의 `call_expression` 및 `identifier`를 수집하여 요약 주석을 삽입.
*   **Example**:
    *   *AS-IS*: `public async saveUser(user: User) { /* implementation hidden */ }`
    *   *TO-BE*: `public async saveUser(user: User) { /* calls: db.users.upsert, cache.invalidate | refs: UserSchema */ }`
*   **에이전트 체감**: 함수 내부를 다 읽지 않고도 "이 함수가 DB를 건드리는지", "어떤 외부 모듈에 의존하는지" 즉시 파악하여 토큰 ROI 극대화.

### 🟡 Feature 2: Predictive Impact DryRun (예지형 편집)
`edit_code` 도구가 단순한 텍스트 변경 도구에서 **"전략적 시뮬레이터"**로 진화합니다.

*   **구현**: `EditCoordinator`가 `dryRun` 시 `DependencyGraph` 및 `ImpactAnalysis`를 연동.
    *   수정 대상 심볼을 참조하는 파일 개수 계산.
    *   타입 정의 변경 시 깨질 가능성이 있는 호출부 리스트업.
    *   0~100 사이의 **Risk Score** 산출.
*   **에이전트 체감**: "이 코드를 고치면 12개 파일이 영향을 받습니다"라는 경고를 미리 받고, 에이전트가 더 안전한 리팩토링 경로를 스스로 재설계함.

### 🟣 Feature 3: Ghost Interface Archeology (유령 인터페이스 복원)
망가진 코드로부터 맥락을 살려내는 **"디지털 포렌식"** 기능입니다.

*   **구현**: 특정 파일이 파싱 불가능하거나 존재하지 않을 때, `SymbolIndex`와 `CallSiteAnalyzer` 데이터를 역방향으로 쿼리.
    *   `ProjectIndex` 내의 모든 파일 중 해당 파일을 import하는 곳들을 전수 조사.
    *   호출부의 패턴(`obj.method(a, b)`)을 분석하여 인터페이스 뼈대 역생성.
*   **에이전트 체감**: 파일이 깨져도 "주변 파일들은 네가 이런 형태(Interface)일 것이라고 믿고 있어"라는 정보를 제공받아, 에이전트가 끊기지 않고 복구 작업을 수행함.

---

## 3. Technical Reality Check (현실성 검증)

본 제안은 허황된 AI의 추측이 아닌, 이미 구축된 데이터를 재조합하는 **확정적 로직**에 기반합니다.

1.  **Data Source**: `src/ast/analysis/CallSiteAnalyzer.ts`에서 이미 호출부 데이터를 수집 중임.
2.  **Logic**: `ImpactAnalysis` 로직은 `DependencyGraph.ts`에 이미 존재함. 이를 `EditCoordinator`와 연결하는 '인터페이스' 작업이 핵심임.
3.  **Feasibility**: 100% 로직 복구가 아닌 **"뼈대(Interface) 복구"**에 집중하므로, 정적 분석 수준에서 완벽하게 구현 가능함.

---

## 4. Consequences

### Positive Impacts ✅
*   **에이전트 자율성 극대화**: 도움 없이도 위험을 감지하고 맥락을 복구함.
*   **압도적 토큰 효율**: '투시형 스켈레톤'을 통해 파일 전체 읽기 빈도를 50% 이상 추가 감소.
*   **LSP를 넘어서는 가치**: LSP가 포기한 "Broken State"와 "Token Economy" 영역에서 독점적 우위 점함.

### Negative Impacts ⚠️
*   **분석 오버헤드**: `dryRun` 시 영향도 분석을 위한 추가 연산 비용 발생 (캐싱으로 해결 가능).
*   **데이터 정합성**: 인덱스가 아주 오래된 경우 Ghost Interface가 부정확할 수 있음 (재인덱싱 유도 로직 필요).

---

## 5. Implementation Roadmap

1.  **Phase 1 (Resilience)**: `manage_project`의 `undo`와 연계된 `GhostScaffolder` POC 구현.
2.  **Phase 2 (Intelligence)**: `SkeletonGenerator` 고도화를 통한 `Semantic Summary` 도입.
3.  **Phase 3 (Safety)**: `EditCoordinator`에 `Impact Prediction` 레이어 통합.
