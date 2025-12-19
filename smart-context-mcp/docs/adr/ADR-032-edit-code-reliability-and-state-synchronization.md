# ADR-032: Edit Code Reliability and State Synchronization

**Status:** Proposed
**Date:** 2025-12-19
**Author:** Smart Context MCP Team
**Related:** ADR-008 (Pragmatic Reliability), ADR-009 (String Matching), ADR-024 (Edit Flexibility)

---

## Executive Summary

`edit_code` 도구 사용 시 발생하는 파일 손상, 이스케이프 문자 오처리, Agent-파일 상태 불일치 문제를 근본적으로 해결하기 위한 아키텍처 개선안을 제시합니다.

---

## 1. Context: 현재 문제점

### 1.1 Agent-파일 상태 불일치 (Critical)

```
Agent가 read_code로 파일 읽음 (version 1)
    ↓
edit_code 호출 → 파일 변경됨 (version 2)
    ↓
Agent의 context는 여전히 version 1 상태
    ↓
다음 edit_code에서 targetString 불일치 → 매칭 실패 또는 잘못된 위치 적용
```

**증상:**
- 연속 편집 시 실패율 증가
- "Match not found" 에러 빈발
- 의도하지 않은 위치에 수정 적용

### 1.2 이스케이프 시퀀스 이중 처리 (High)

**MCP JSON 통신 경로:**
```
Agent 전송: "line1\nline2"
    ↓ JSON.stringify (Claude/MCP)
MCP 수신: "line1\\nline2"
    ↓ JSON.parse
smart-context-mcp: "line1\nline2"
```

**문제점:**
- Agent가 리터럴 `\n` (2글자)을 보내는지, 실제 개행을 보내는지 모호함
- `generateEscapeAwareVariants`가 3가지 variant 생성 → 잘못된 variant 매칭 위험
- `decodeStructuralEscapeSequences`의 따옴표 추적이 복잡한 코드에서 실패

### 1.3 과도한 정규화 유연성 (High)

| Level | 위험도 | 문제 |
|-------|--------|------|
| `structural` | 매우 높음 | 따옴표 종류 무시 → 다른 코드에 매칭 |
| `whitespace` | 높음 | 모든 공백 무시 → 다중 매칭 |
| `indentation` | 중간 | 들여쓰기 무시 → 잘못된 블록 매칭 |

### 1.4 캐시 불일치 (Medium)

- `SkeletonCache`의 mtime 기반 캐시가 빠른 연속 편집에서 동일한 mtime 반환 가능
- `invalidateTouchedFiles` 호출 타이밍과 캐시 갱신 사이 간극

---

## 2. Decision: 해결 전략

### 2.1 파일 버전 기반 상태 동기화 시스템

**핵심 아이디어:** 각 파일에 논리적 버전 번호를 부여하여 Agent와 실제 파일 상태의 동기화 보장

```typescript
interface FileVersionInfo {
    version: number;           // 논리적 버전 (edit마다 증가)
    contentHash: string;       // xxhash 기반 콘텐츠 해시
    lastModified: number;      // mtime
    encoding: 'utf-8';
    lineEnding: 'lf' | 'crlf';
}

interface EditCodeArgs {
    edits: Edit[];
    // NEW: 선택적 버전 검증
    fileVersions?: Record<string, {
        expectedVersion?: number;
        expectedHash?: string;
    }>;
}
```

**동작 방식:**
1. `read_code`/`read_file` 응답에 `FileVersionInfo` 포함
2. Agent가 `edit_code` 호출 시 `expectedVersion` 또는 `expectedHash` 전달 (선택)
3. 불일치 시 `VERSION_MISMATCH` 에러와 함께 현재 파일 상태 반환
4. Agent가 파일을 다시 읽고 재시도

### 2.2 이스케이프 처리 단순화

**원칙:** "Explicit is better than implicit"

```typescript
interface Edit {
    targetString: string;
    replacementString: string;
    // NEW: 명시적 이스케이프 모드
    escapeMode?: 'literal' | 'interpreted';
    // literal (기본값): 문자열을 있는 그대로 매칭
    // interpreted: \n, \t 등을 실제 제어문자로 해석
}
```

**변경 사항:**
- `generateEscapeAwareVariants` 제거 → 명시적 `escapeMode`로 대체
- 기본값은 `literal` → 가장 예측 가능한 동작
- Agent가 명시적으로 `interpreted`를 요청할 때만 디코딩

### 2.3 정규화 기본값 보수화

```typescript
const DEFAULT_NORMALIZATION: NormalizationLevel = 'line-endings';
const SAFE_NORMALIZATIONS: NormalizationLevel[] = ['exact', 'line-endings', 'trailing'];
const RISKY_NORMALIZATIONS: NormalizationLevel[] = ['indentation', 'whitespace', 'structural'];

// risky normalization 사용 시 경고 반환
if (RISKY_NORMALIZATIONS.includes(edit.normalization)) {
    warnings.push({
        code: 'RISKY_NORMALIZATION',
        message: `Using '${edit.normalization}' normalization may match unintended locations.`,
        suggestion: 'Consider using beforeContext/afterContext for disambiguation.'
    });
}
```

### 2.4 편집 후 상태 피드백 강화

```typescript
interface EditCodeResult {
    success: boolean;
    results: EditResult[];
    // NEW: 수정된 파일들의 새 상태
    updatedFileStates?: Record<string, {
        newVersion: number;
        newHash: string;
        affectedLineRange: { start: number; end: number };
        newContent?: string;
    }>;
}
```

---

## 3. Technical Implementation

### 3.1 FileVersionManager 클래스 추가

```typescript
// src/engine/FileVersionManager.ts

export class FileVersionManager {
    private versions: Map<string, FileVersionInfo> = new Map();

    async getVersion(filePath: string): Promise<FileVersionInfo> {
        const cached = this.versions.get(filePath);
        const stat = await this.fileSystem.stat(filePath);

        if (!cached || cached.lastModified !== stat.mtimeMs) {
            const content = await this.fileSystem.readFile(filePath);
            const newVersion: FileVersionInfo = {
                version: (cached?.version ?? 0) + 1,
                contentHash: this.computeHash(content),
                lastModified: stat.mtimeMs,
                encoding: 'utf-8',
                lineEnding: this.detectLineEnding(content)
            };
            this.versions.set(filePath, newVersion);
            return newVersion;
        }

        return cached;
    }

    incrementVersion(filePath: string, newContent: string): FileVersionInfo {
        const current = this.versions.get(filePath);
        const newVersion: FileVersionInfo = {
            version: (current?.version ?? 0) + 1,
            contentHash: this.computeHash(newContent),
            lastModified: Date.now(),
            encoding: 'utf-8',
            lineEnding: this.detectLineEnding(newContent)
        };
        this.versions.set(filePath, newVersion);
        return newVersion;
    }

    validateVersion(filePath: string, expected: { version?: number; hash?: string }): boolean {
        const current = this.versions.get(filePath);
        if (!current) return true;

        if (expected.version !== undefined && current.version !== expected.version) {
            return false;
        }
        if (expected.hash !== undefined && current.contentHash !== expected.hash) {
            return false;
        }
        return true;
    }
}
```

### 3.2 EditorEngine 수정

```typescript
// src/engine/Editor.ts 변경사항

private applyEditsInternal(originalContent: string, edits: Edit[]): Match[] {
    for (const edit of edits) {
        if (edit.escapeMode === 'interpreted') {
            edit.targetString = this.decodeEscapeSequences(edit.targetString);
            edit.replacementString = this.decodeEscapeSequences(edit.replacementString ?? '');
        }
        const match = this.findMatch(originalContent, edit, lineCounter);
    }
}

private findMatchWithEscapeVariants(content: string, edit: Edit, lineCounter: LineCounter): Match {
    return this.findMatch(content, edit, lineCounter);
}
```

### 3.3 read_code 응답 확장

```typescript
interface ReadCodeResult {
    content: string;
    metadata: {
        lines: number;
        language: string | null;
        path: string;
    };
    versionInfo: {
        version: number;
        contentHash: string;
        lineEnding: 'lf' | 'crlf';
    };
}
```

---

## 4. Consequences

### 4.1 Positive

- ✅ Agent-파일 상태 불일치로 인한 편집 실패 대폭 감소
- ✅ 이스케이프 처리의 예측 가능성 향상
- ✅ 위험한 정규화 사용 시 명시적 경고
- ✅ 연속 편집 작업의 안정성 향상
- ✅ 디버깅 용이성 증가 (버전 추적)

### 4.2 Negative

- ⚠️ 하위 호환성: 기존 escapeVariants 동작에 의존하던 사용 패턴 변경 필요
- ⚠️ 응답 크기 증가: versionInfo, updatedFileStates 추가
- ⚠️ 메모리 사용량 소폭 증가: FileVersionManager 상태 유지

### 4.3 Migration Path

1. **Phase 1 (v1.x):** `escapeMode`, `fileVersions` 옵션 추가 (선택적), 기존 동작 유지
2. **Phase 2 (v2.0):** 기본 `escapeMode`를 `literal`로, 기본 normalization을 `line-endings`로 변경

---

## 5. Implementation Roadmap

- [ ] Step 1: `src/engine/FileVersionManager.ts` 생성
- [ ] Step 2: read_code/read_file 응답에 `versionInfo` 추가
- [ ] Step 3: edit_code에 `fileVersions` 파라미터 및 `VERSION_MISMATCH` 에러 처리
- [ ] Step 4: `escapeMode` 파라미터 추가, `generateEscapeAwareVariants` deprecation
- [ ] Step 5: 기본 normalization을 `line-endings`로 변경
- [ ] Step 6: 테스트 및 문서화

---

## 6. Verification Plan

### Unit Tests
```typescript
describe('FileVersionManager', () => {
    it('should increment version on file modification');
    it('should detect version mismatch');
    it('should compute consistent content hash');
});

describe('EditorEngine escapeMode', () => {
    it('should treat \\n as literal 2-char sequence in literal mode');
    it('should convert \\n to newline in interpreted mode');
});
```

### Integration Tests
```typescript
describe('edit_code state synchronization', () => {
    it('should reject edit when file version mismatches');
    it('should return updated file state after successful edit');
});
```

---

## 7. Performance Impact Analysis

### Memory Overhead
| Scenario | Additional Memory |
|----------|-------------------|
| 1000 files | ~200 KB |
| 10000 files | ~2 MB |

### CPU Overhead
| Operation | Delta |
|-----------|-------|
| read_code | +1ms (hash 계산) |
| edit_code (단일) | +2ms (버전 검증) |

---

## 8. Rollback and Recovery Strategy

### 8.1 VERSION_MISMATCH 복구 절차
```
VERSION_MISMATCH 에러 → Agent가 read_code로 재읽기 → 새 버전으로 edit_code 재시도
```

### 8.2 트랜잭션 모드
```typescript
transactionMode?: 'all-or-nothing' | 'best-effort';
```

### 8.3 백업 보존 정책
```typescript
interface BackupRetentionPolicy {
    maxBackupsPerFile: number;     // 기본값: 10
    minRetentionHours: number;     // 기본값: 24
    maxRetentionDays: number;      // 기본값: 7
}
```

---

## 9. Related Files

**수정 대상:**
- `src/engine/Editor.ts`
- `src/engine/FileVersionManager.ts` (신규)
- `src/index.ts`
- `src/types.ts`

**테스트:**
- `src/tests/FileVersionManager.test.ts` (신규)
- `src/tests/EditorEngine.test.ts`
- `src/tests/edit_code.integration.test.ts`
