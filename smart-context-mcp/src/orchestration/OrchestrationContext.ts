
import { IntentCategory } from './IntentRouter.js';


export interface StepResult {
  id: string;
  tool: string;
  args: any;
  output: any;
  status: 'success' | 'failure' | 'partial';
  duration: number;
  timestamp: number;
}

export interface ErrorContext {
  code: string;
  message: string;
  tool?: string;
  target?: string;
  suggestedLineRange?: [number, number];
  stack?: string;
}

/**
 * Stateful Context: 오케스트레이션 워크플로우 실행 중 상태와 이력을 관리합니다.
 */
export class OrchestrationContext {
  private steps: StepResult[] = [];
  private sharedState: Map<string, any> = new Map();
  private errors: ErrorContext[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * 실행된 단계의 결과를 추가합니다.
   */
  public addStep(result: Omit<StepResult, 'timestamp'>): void {
    this.steps.push({
      ...result,
      timestamp: Date.now()
    });
  }

  /**
   * 공유 상태에 데이터를 저장합니다.
   */
  public setState(key: string, value: any): void {
    this.sharedState.set(key, value);
  }

  /**
   * 공유 상태에서 데이터를 가져옵니다.
   */
  public getState<T>(key: string): T | undefined {
    return this.sharedState.get(key) as T;
  }

  /**
   * 에러 정보를 기록합니다.
   */
  public addError(error: ErrorContext): void {
    this.errors.push(error);
  }

  /**
   * 마지막 실행 결과를 가져옵니다.
   */
  public getLastResult(): StepResult | undefined {
    return this.steps[this.steps.length - 1];
  }

    /**
   * 템플릿 문자열을 현재 컨텍스트의 값으로 치환합니다.
   * e.g., "${step1.output.filePath}" -> 실제 경로
   */
  public resolveTemplate(template: string): any {
    if (typeof template !== 'string' || !template.includes('${')) {
      return template;
    }

    return template.replace(/\$\{([^}]+)\}/g, (_, path) => {
      const parts = path.split('.');
      
      // 컨텍스트 데이터 맵 구성
      const stepData: Record<string, any> = {};
      this.steps.forEach(s => {
        stepData[s.id] = s;
      });

      let current: any = {
        state: Object.fromEntries(this.sharedState),
        ...stepData
      };

      for (const part of parts) {
        if (current === undefined || current === null) return undefined;
        
        // 배열 인덱스 처리 (e.g., results[0])
        const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
        if (arrayMatch) {
          const [, key, index] = arrayMatch;
          current = current[key]?.[parseInt(index)];
        } else {
          current = current[part];
        }
      }
      return current !== undefined ? current : `\${${path}}`;
    });
  }


  public getFullHistory(): StepResult[] {
    return [...this.steps];
  }

  public getErrors(): ErrorContext[] {
    return [...this.errors];
  }

  public clearErrors(): void {
    this.errors = [];
  }

  public getDuration(): number {
    return Date.now() - this.startTime;
  }
}
