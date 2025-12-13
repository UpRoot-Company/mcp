import * as path from 'path';
import * as fs from 'fs';

/**
 * RootDetector
 *
 * 주어진 경로에서 프로젝트 루트 디렉토리를 자동으로 감지합니다.
 *
 * IDE 플러그인이 정확한 프로젝트 루트를 모를 때 유용합니다.
 * 예: /Users/devkwan/project/deeply/nested/src/file.ts → /Users/devkwan/project
 *
 * 루트 마커:
 * 1. .git (Git 저장소)
 * 2. package.json (Node.js 프로젝트)
 * 3. tsconfig.json (TypeScript 프로젝트)
 * 4. pyproject.toml (Python 프로젝트)
 * 5. .env.local (환경 설정)
 * 6. README.md (일반 프로젝트)
 */
export class RootDetector {
    private static readonly DEFAULT_ROOT_MARKERS = [
        '.git',
        'package.json',
        'tsconfig.json',
        'pyproject.toml',
        '.env.local',
        'Cargo.toml', // Rust
        'go.mod', // Go
        '.python-version', // Python
        'pom.xml', // Java/Maven
        'build.gradle', // Java/Gradle
        'README.md'
    ];

    private static readonly MAX_DEPTH = 15; // 최대 15레벨 위로 탐색

    /**
     * 주어진 경로에서 프로젝트 루트 자동 감지
     *
     * @param fromPath - 검색 시작 경로 (절대 또는 상대)
     * @param customMarkers - 커스텀 마커 (기본값 사용 안함)
     * @returns 감지된 프로젝트 루트 경로 (절대경로)
     */
    static async detectRoot(fromPath: string, customMarkers?: string[]): Promise<string> {
        const markers = customMarkers || this.DEFAULT_ROOT_MARKERS;
        let startDir: string;

        if (path.isAbsolute(fromPath)) {
            // 파일인지 디렉토리인지 확인
            try {
                const stats = await fs.promises.stat(fromPath);
                startDir = stats.isFile() ? path.dirname(fromPath) : fromPath;
            } catch {
                // 파일이 없으면 디렉토리로 간주
                startDir = fromPath;
            }
        } else {
            startDir = path.resolve(process.cwd(), fromPath);
        }

        return this._traverseUp(startDir, markers);
    }

    /**
     * 동기 버전 (파일 시스템 동기 API 사용)
     * detectRoot의 빠른 대안
     */
    static detectRootSync(fromPath: string, customMarkers?: string[]): string {
        const markers = customMarkers || this.DEFAULT_ROOT_MARKERS;
        let startDir: string;

        if (path.isAbsolute(fromPath)) {
            // 파일인지 디렉토리인지 확인
            try {
                const stats = fs.statSync(fromPath);
                startDir = stats.isFile() ? path.dirname(fromPath) : fromPath;
            } catch {
                // 파일이 없으면 디렉토리로 간주
                startDir = fromPath;
            }
        } else {
            startDir = path.resolve(process.cwd(), fromPath);
        }

        return this._traverseUpSync(startDir, markers);
    }

    /**
     * 복수의 경로에서 공통 루트 찾기
     * (여러 파일이 같은 프로젝트에 속하는지 확인)
     */
    static async detectCommonRoot(paths: string[], customMarkers?: string[]): Promise<string> {
        const roots = await Promise.all(
            paths.map(p => this.detectRoot(p, customMarkers))
        );

        // 모든 경로의 공통 부모 찾기
        let commonRoot = roots[0];
        for (const root of roots.slice(1)) {
            while (!root.startsWith(commonRoot) && commonRoot !== path.dirname(commonRoot)) {
                commonRoot = path.dirname(commonRoot);
            }
        }

        return commonRoot;
    }

    /**
     * 경로가 프로젝트 내부인지 확인
     */
    static async isWithinProject(filePath: string, projectRoot?: string): Promise<boolean> {
        const root = projectRoot || (await this.detectRoot(filePath));
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

        const normalized1 = absPath.split(path.sep).join('/');
        const normalized2 = root.split(path.sep).join('/');

        return normalized1.startsWith(normalized2 + '/') || normalized1 === normalized2;
    }

    /**
     * 현재 작업 디렉토리의 루트 감지
     */
    static async detectCurrentProjectRoot(customMarkers?: string[]): Promise<string> {
        return this.detectRoot(process.cwd(), customMarkers);
    }

    /**
     * 내부: 위로 올라가며 마커 찾기 (비동기)
     */
    private static async _traverseUp(startDir: string, markers: string[]): Promise<string> {
        let currentDir = startDir;
        let depth = 0;

        while (depth < this.MAX_DEPTH) {
            // 각 마커가 현재 디렉토리에 있는지 확인
            for (const marker of markers) {
                const markerPath = path.join(currentDir, marker);
                try {
                    await fs.promises.access(markerPath);
                    // 마커 찾음!
                    return currentDir;
                } catch {
                    // 파일 없음, 다음 마커 확인
                }
            }

            // 부모 디렉토리로 이동
            const parent = path.dirname(currentDir);
            if (parent === currentDir) {
                // 파일 시스템 루트에 도달
                break;
            }

            currentDir = parent;
            depth++;
        }

        // 마커를 찾지 못한 경우
        // 조상 디렉토리 기반으로 폴백
        return this._findFallbackRoot(startDir);
    }

    /**
     * 내부: 위로 올라가며 마커 찾기 (동기)
     */
    private static _traverseUpSync(startDir: string, markers: string[]): string {
        let currentDir = startDir;
        let depth = 0;

        while (depth < this.MAX_DEPTH) {
            // 각 마커가 현재 디렉토리에 있는지 확인
            for (const marker of markers) {
                const markerPath = path.join(currentDir, marker);
                try {
                    fs.accessSync(markerPath);
                    // 마커 찾음!
                    return currentDir;
                } catch {
                    // 파일 없음, 다음 마커 확인
                }
            }

            // 부모 디렉토리로 이동
            const parent = path.dirname(currentDir);
            if (parent === currentDir) {
                // 파일 시스템 루트에 도달
                break;
            }

            currentDir = parent;
            depth++;
        }

        // 마커를 찾지 못한 경우
        return this._findFallbackRoot(startDir);
    }

    /**
     * 폴백: 마커를 찾지 못한 경우 처리
     *
     * 전략:
     * 1. node_modules가 있는 가장 상위 디렉토리
     * 2. .vscode, .idea 등 IDE 설정 폴더
     * 3. 마지막 폴백: 최상위 1레벨 위
     */
    private static _findFallbackRoot(startDir: string): string {
        let current = startDir;
        let nodeModulesDir: string | null = null;

        // node_modules의 가장 상위 위치 찾기
        for (let i = 0; i < 10; i++) {
            const nodeModulesPath = path.join(current, 'node_modules');
            try {
                if (fs.statSync(nodeModulesPath).isDirectory()) {
                    nodeModulesDir = current;
                }
            } catch {
                // 없음
            }

            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }

        // node_modules를 찾았다면 그곳을 루트로 사용
        if (nodeModulesDir) {
            return nodeModulesDir;
        }

        // 최종 폴백: 시작 디렉토리 자체
        return startDir;
    }

    /**
     * 디버깅: 마커 탐색 과정 상세 정보
     */
    static async detectRootWithDetails(
        fromPath: string,
        customMarkers?: string[]
    ): Promise<{ root: string; markerFound: string; depth: number }> {
        const markers = customMarkers || this.DEFAULT_ROOT_MARKERS;
        let startDir: string;

        if (path.isAbsolute(fromPath)) {
            // 파일인지 디렉토리인지 확인
            try {
                const stats = await fs.promises.stat(fromPath);
                startDir = stats.isFile() ? path.dirname(fromPath) : fromPath;
            } catch {
                // 파일이 없으면 디렉토리로 간주
                startDir = fromPath;
            }
        } else {
            startDir = path.resolve(process.cwd(), fromPath);
        }

        let currentDir = startDir;
        let depth = 0;

        while (depth < this.MAX_DEPTH) {
            for (const marker of markers) {
                const markerPath = path.join(currentDir, marker);
                try {
                    await fs.promises.access(markerPath);
                    return {
                        root: currentDir,
                        markerFound: marker,
                        depth
                    };
                } catch {
                    // 계속
                }
            }

            const parent = path.dirname(currentDir);
            if (parent === currentDir) break;

            currentDir = parent;
            depth++;
        }

        return {
            root: this._findFallbackRoot(startDir),
            markerFound: 'FALLBACK',
            depth: -1
        };
    }
}
