
export type IntentCategory = 'understand' | 'change' | 'navigate' | 'read' | 'write' | 'manage';

export interface IntentConstraints {
  depth?: 'shallow' | 'standard' | 'deep';
  scope?: 'symbol' | 'file' | 'module' | 'project';
  includeImpact?: boolean;
  dryRun?: boolean;
  limit?: number;
  edits?: any[];
  view?: 'full' | 'skeleton' | 'fragment';
  lineRange?: string | [number, number];
  includeProfile?: boolean;
  includeHash?: boolean;
  targetPath?: string;
  content?: string;
  template?: string;
  context?: "definitions" | "usages" | "tests" | "docs" | "all";
  include?: {
    callGraph?: boolean;
    hotSpots?: boolean;
    pageRank?: boolean;
    dependencies?: boolean;
  };
}


export interface ParsedIntent {
  category: IntentCategory;
  action: string;
  targets: string[];
  originalIntent: string;
  constraints: IntentConstraints;
  confidence: number;
}

/**
 * IntentRouter: 자연어 의도를 분석하여 적절한 기둥(Pillar)과 액션을 결정합니다.
 */
export class IntentRouter {
  /**
   * 자연어 의도를 분석하여 구조화된 ParsedIntent를 반환합니다.
   */
  public parse(intent: string): ParsedIntent {
    const category = this.detectCategory(intent);
    const targets = this.extractTargets(intent);
    const action = this.extractAction(intent, category);
    const constraints = this.inferConstraints(intent, category);
    
    return {
      category,
      action,
      targets,
      originalIntent: intent,
      constraints,
      confidence: this.calculateConfidence(intent, category)
    };
  }

      private detectCategory(intent: string): IntentCategory {
    const patterns: [RegExp, IntentCategory][] = [
      // 1. Specific action intent priority
      [/\b(modify|change|add|remove|refactor|fix|bug|patch|update|implement|write|edit|수정|변경|추가|삭제|리팩토링|버그|패치)\b/i, 'change'],
      [/\b(find|search|where|location|definition|usage|call|trace|look for|locate|찾|검색|어디|정의|사용|호출|추적|탐색)\b/i, 'navigate'],
      [/\b(create|make|scaffold|generate|template|new file|생성|만들|작성|스캐폴드|템플릿)\b/i, 'write'],
      [/\b(read|view|preview|content|code|diff|compare|open|show|읽|보기|미리보기|내용|코드|비교)\b/i, 'read'],
      [/\b(status|undo|redo|rebuild|index|history|manage|rollback|상태|되돌리|재실행|인덱스|관리)\b/i, 'manage'],
      // 2. Broad understanding intent at the end
      [/\b(understand|comprehend|analyze|explain|structure|architecture|logic|summary|report|diagram|이해|분석|설명|구조|아키텍처|요약)\b/i, 'understand'],
    ];

    for (const [pattern, category] of patterns) {
      if (pattern.test(intent)) return category;
    }

    return 'understand';
  }

  private extractTargets(intent: string): string[] {
    // 1. Extract quoted words or path patterns
    const quotedMatch = intent.match(/['"]([^'"]+)['"]/g);
    if (quotedMatch) {
      return quotedMatch.map(m => m.replace(/['"]/g, ''));
    }

    // 2. Clean intent by removing common stop words and action verbs
    const cleanedIntent = intent
      .replace(/\b(of|the|in|at|on|for|with|from|by|to|and|a|an)\b/gi, ' ')
      .replace(/\b(modify|change|add|remove|refactor|fix|bug|patch|update|implement|write|edit|find|search|look for|create|make|generate|read|view|show|understand|analyze|explain)\b/gi, ' ')
      .trim();

    // 3. Extract filenames, paths, or PascalCase/camelCase symbols
    const commonPattern = /\b([a-zA-Z0-9_\-\.\/]+\.(ts|js|json|md|tsx|jsx)|[A-Z][a-zA-Z0-9]+|[a-z][a-zA-Z0-9]+)\b/g;
    const matches = cleanedIntent.match(commonPattern);
    
    if (matches && matches.length > 0) {
      return Array.from(new Set(matches));
    }

    // 4. Last resort: Longest word (highest probability of being a noun)
    const words = cleanedIntent.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 0) {
      return [words.sort((a, b) => b.length - a.length)[0]];
    }

    return [];
  }



  private extractAction(intent: string, category: IntentCategory): string {
    // 카테고리별 세부 액션 추출 (단순화된 구현)
    if (category === 'change') return 'modify';
    if (category === 'navigate') return 'find';
    if (category === 'understand') return 'analyze';
    return 'execute';
  }

  private inferConstraints(intent: string, category: IntentCategory): IntentConstraints {
    const constraints: IntentConstraints = {};

    if (intent.includes('깊이') || intent.includes('상세')) constraints.depth = 'deep';
    if (intent.includes('간단')) constraints.depth = 'shallow';
    
    if (category === 'change') {
      constraints.dryRun = !intent.includes('실제로') && !intent.includes('바로 적용');
      constraints.includeImpact = true;
    }

    if (intent.includes('전체') || intent.includes('프로젝트')) constraints.scope = 'project';

    const limitMatch = intent.match(/(\d+)개/);
    if (limitMatch) constraints.limit = parseInt(limitMatch[1]);

    return constraints;
  }

  private calculateConfidence(intent: string, category: IntentCategory): number {
    // 키워드 매칭 기반 신뢰도 계산 (0.5 ~ 1.0)
    return 0.8; 
  }
}
