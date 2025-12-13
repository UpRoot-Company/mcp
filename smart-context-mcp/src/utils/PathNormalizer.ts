import * as path from 'path';
import * as fs from 'fs';

/**
 * PathNormalizer
 *
 * IDE 플러그인과 CLI 도구 간의 경로 차이를 자동으로 처리합니다.
 *
 * 문제: VSCode 플러그인은 절대경로를 전송하지만, CLI는 상대경로를 사용합니다.
 * 해결: 모든 경로를 자동으로 정규화하여 상대경로로 변환합니다.
 *
 * 예시:
 * - 절대경로: /Users/devkwan/project/src/file.ts → src/file.ts
 * - 상대경로: src/file.ts → src/file.ts (변화 없음)
 * - 부모 경로: ../other/file.ts → other/file.ts (정규화)
 */
export class PathNormalizer {
    private rootDir: string;
    private logger: any; // StructuredLogger 타입

    constructor(rootDir: string, logger?: any) {
        this.rootDir = path.normalize(rootDir);
        this.logger = logger;
    }

    /**
     * 절대경로든 상대경로든 항상 루트 기준 상대경로로 정규화
     *
     * @param inputPath - 절대경로 또는 상대경로
     * @returns 루트 기준 상대경로
     * @throws {Error} 경로가 루트 외부인 경우
     */
    normalize(inputPath: string): string {
        if (!inputPath || typeof inputPath !== 'string') {
            throw new Error(`Invalid input path: ${inputPath}`);
        }

        // 1. 입력 경로를 절대경로로 변환
        let absolutePath: string;
        if (path.isAbsolute(inputPath)) {
            absolutePath = path.normalize(inputPath);
        } else {
            // 상대경로는 루트 기준으로 해석
            absolutePath = path.normalize(path.resolve(this.rootDir, inputPath));
        }

        // 2. 정규화된 경로가 루트 내부에 있는지 확인
        const resolvedRoot = path.normalize(this.rootDir);

        // 경로 비교: Unix와 Windows 호환성
        const normalizedPath = absolutePath.split(path.sep).join('/');
        const normalizedRoot = resolvedRoot.split(path.sep).join('/');

        if (!normalizedPath.startsWith(normalizedRoot + '/') && normalizedPath !== normalizedRoot) {
            this.logger?.warn('PathNormalizer.normalize', {
                inputPath,
                absolutePath,
                rootDir: resolvedRoot,
                message: 'Path is outside root directory'
            });

            throw new Error(
                `SecurityViolation: Path "${inputPath}" is outside the allowed root directory "${resolvedRoot}".`
            );
        }

        // 3. 절대경로를 루트 기준 상대경로로 변환
        let relativePath = path.relative(resolvedRoot, absolutePath);

        // 4. 정규화 (.. 제거, 중복된 슬래시 제거)
        relativePath = path.normalize(relativePath);

        // 5. Windows 경로를 Unix 형식으로 통일 (크로스플랫폼 호환성)
        relativePath = relativePath.split(path.sep).join('/');

        // 루트 디렉토리 자체인 경우 '.' 반환
        if (relativePath === '.' || relativePath === '') {
            return '.';
        }

        this.logger?.debug('PathNormalizer.normalize', {
            inputPath,
            normalized: relativePath
        });

        return relativePath;
    }

    /**
     * 여러 경로를 한 번에 정규화
     * 배치 작업에 유용합니다.
     */
    normalizeBatch(paths: string[]): string[] {
        return paths.map(p => this.normalize(p));
    }

    /**
     * 심볼릭 링크도 따라가서 실제 경로를 정규화합니다.
     * 보안이 중요한 경우 이 메서드를 사용하세요.
     *
     * @param inputPath - 절대경로 또는 상대경로
     * @returns 심볼릭 링크 해석 후 정규화된 상대경로
     */
    async normalizeWithSymlinks(inputPath: string): Promise<string> {
        if (!inputPath || typeof inputPath !== 'string') {
            throw new Error(`Invalid input path: ${inputPath}`);
        }

        try {
            // 1. 입력 경로를 절대경로로 변환
            let absolutePath: string;
            if (path.isAbsolute(inputPath)) {
                absolutePath = inputPath;
            } else {
                absolutePath = path.resolve(this.rootDir, inputPath);
            }

            // 2. 심볼릭 링크 해석하여 실제 경로 얻기
            const realPath = await fs.promises.realpath(absolutePath);

            // 3. 실제 경로가 루트 내부에 있는지 확인
            const resolvedRoot = path.normalize(this.rootDir);
            const normalizedReal = realPath.split(path.sep).join('/');
            const normalizedRoot = resolvedRoot.split(path.sep).join('/');

            if (!normalizedReal.startsWith(normalizedRoot + '/') && normalizedReal !== normalizedRoot) {
                throw new Error(
                    `SecurityViolation: Real path "${realPath}" is outside the allowed root directory.`
                );
            }

            // 4. 실제 경로를 상대경로로 변환
            let relativePath = path.relative(resolvedRoot, realPath);
            relativePath = path.normalize(relativePath);
            relativePath = relativePath.split(path.sep).join('/');

            if (relativePath === '.' || relativePath === '') {
                return '.';
            }

            this.logger?.debug('PathNormalizer.normalizeWithSymlinks', {
                inputPath,
                realPath,
                normalized: relativePath
            });

            return relativePath;
        } catch (error: any) {
            // 파일이 존재하지 않는 경우에도 일반 normalize로 처리
            if (error.code === 'ENOENT') {
                return this.normalize(inputPath);
            }
            throw error;
        }
    }

    /**
     * 정규화된 상대경로를 다시 절대경로로 변환
     * (역함수: 디버깅이나 로깅에 유용)
     */
    toAbsolute(relativePath: string): string {
        return path.normalize(path.resolve(this.rootDir, relativePath));
    }

    /**
     * 경로의 보안 검증만 수행 (실제 정규화는 안함)
     * 예: 삭제 작업 전 확인
     */
    isWithinRoot(inputPath: string): boolean {
        // Validate input
        if (!inputPath || typeof inputPath !== 'string') {
            return false;
        }

        try {
            let absolutePath: string;
            if (path.isAbsolute(inputPath)) {
                absolutePath = path.normalize(inputPath);
            } else {
                absolutePath = path.normalize(path.resolve(this.rootDir, inputPath));
            }

            const resolvedRoot = path.normalize(this.rootDir);
            const normalizedPath = absolutePath.split(path.sep).join('/');
            const normalizedRoot = resolvedRoot.split(path.sep).join('/');

            return normalizedPath.startsWith(normalizedRoot + '/') || normalizedPath === normalizedRoot;
        } catch {
            return false;
        }
    }

    /**
     * 두 경로가 같은 파일을 가리키는지 확인
     * (정규화, 심볼릭 링크 해석 후 비교)
     */
    async isSamePath(path1: string, path2: string): Promise<boolean> {
        try {
            const normalized1 = await this.normalizeWithSymlinks(path1);
            const normalized2 = await this.normalizeWithSymlinks(path2);
            return normalized1 === normalized2;
        } catch {
            return false;
        }
    }

    /**
     * 루트 디렉토리 변경
     * (서버가 다양한 작업공간을 다루는 경우 사용)
     */
    setRootDir(newRoot: string): void {
        this.rootDir = path.normalize(newRoot);
        this.logger?.info('PathNormalizer.setRootDir', { newRoot });
    }

    /**
     * 현재 루트 디렉토리 반환
     */
    getRootDir(): string {
        return this.rootDir;
    }
}
