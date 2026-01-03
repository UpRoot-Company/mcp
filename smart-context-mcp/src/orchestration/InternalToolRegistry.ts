
/**
 * InternalTool: 개별 도구의 인터페이스
 */
export interface InternalTool {
  name: string;
  execute(args: any): Promise<any>;
}

/**
 * InternalToolRegistry: 기존의 모든 세부 도구들을 등록하고 접근을 제어합니다.
 */
export class InternalToolRegistry {
  private tools: Map<string, (args: any) => Promise<any>> = new Map();
  private metadata: Map<string, any> = new Map();

  /**
   * 도구 이름과 실행 함수를 등록합니다.
   */
  public register(name: string, handler: (args: any) => Promise<any>): void {
    this.tools.set(name, handler);
  }

  /**
   * 메타데이터를 저장합니다 (예: searchEngine 참조).
   */
  public setMetadata(key: string, value: any): void {
    this.metadata.set(key, value);
  }

  /**
   * 메타데이터를 가져옵니다.
   */
  public getMetadata<T = any>(key: string): T | undefined {
    return this.metadata.get(key) as T;
  }

  /**
   * 도구 이름으로 실행합니다.
   */
  public async execute(name: string, args: any): Promise<any> {
    const handler = this.tools.get(name);
    if (!handler) {
      throw new Error(`Internal tool not found: ${name}`);
    }
    return await handler(args);
  }


  /**
   * 등록된 모든 도구 이름을 반환합니다.
   */
  public getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 도구 핸들러를 가져옵니다.
   */
  public get(name: string): ((args: any) => Promise<any>) | undefined {
    return this.tools.get(name);
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}
