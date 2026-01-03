import * as path from 'path';
import { performance } from 'perf_hooks';
import { AstBackend, AstDocument } from './AstBackend.js';
import { WebTreeSitterBackend } from './WebTreeSitterBackend.js';
import { JsAstBackend } from './JsAstBackend.js';
import { SnapshotBackend } from './SnapshotBackend.js';
import { EngineConfig, LOD_LEVEL, AnalysisRequest, LODResult, LODPromotionStats } from '../types.js';
import { LanguageConfigLoader } from '../config/LanguageConfig.js';
import { AdaptiveAstManager } from './AdaptiveAstManager.js';
import { FeatureFlags } from '../config/FeatureFlags.js';

export class AstManager implements AdaptiveAstManager {
    private static instance: AstManager;
    private initialized = false;
    private backend?: AstBackend;
    private engineConfig: EngineConfig;
    private activeBackend?: string;
    private languageConfig?: LanguageConfigLoader;

    // NEW: LOD promotion statistics
    private lodStats: LODPromotionStats = {
        l0_to_l1: 0,
        l1_to_l2: 0,
        l2_to_l3: 0,
        fallback_rate: 0,
        avg_promotion_time_ms: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 },
        total_files: 0
    };

    private constructor() {
        this.backend = new WebTreeSitterBackend();
        this.engineConfig = { mode: 'prod', parserBackend: 'auto' };
    }

    public static getInstance(): AstManager {
        if (!AstManager.instance) {
            AstManager.instance = new AstManager();
        }
        return AstManager.instance;
    }

    public static resetForTesting(): void {
        if (AstManager.instance) {
            if (AstManager.instance.backend?.dispose) {
                AstManager.instance.backend.dispose();
            }
            AstManager.instance.initialized = false;
            AstManager.instance.backend = undefined;
            AstManager.instance.engineConfig = { mode: 'prod', parserBackend: 'auto' };
            AstManager.instance.activeBackend = undefined;
            AstManager.instance.languageConfig?.dispose();
            AstManager.instance.languageConfig = undefined;
        }
    }

    public registerBackend(backend: AstBackend): void {
        if (this.backend && this.backend.dispose) {
            this.backend.dispose();
        }
        this.backend = backend;
        this.activeBackend = backend.name;
        this.initialized = true;
    }

    public async init(config?: EngineConfig): Promise<void> {
        const resolved = this.resolveConfig(config);
        this.engineConfig = resolved;
        const root = resolved.rootPath ?? process.cwd();
        this.languageConfig?.dispose();
        this.languageConfig = new LanguageConfigLoader(root);
        const isTestEnv = resolved.mode === 'test' || process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
        if (!isTestEnv) {
            this.languageConfig.watch(() => {
                console.info('[LanguageConfig] Reloaded language mappings');
            });
        }

        if (this.initialized) {
            return;
        }

        await this.initializeBackend();
    }

    public async warmup(languages: string[] = ['tsx', 'python', 'json']): Promise<void> {
        // Backend specific warmup could be added to interface, for now assume initialized
        if (!this.initialized) await this.init();
    }

    public async parseFile(filePath: string, content: string): Promise<AstDocument> {
        if (!this.initialized) await this.init();
        const mapping = this.getLanguageMapping(filePath);
        return this.backend!.parseFile(filePath, content, mapping?.languageId);
    }

    public async getParserForFile(filePath: string): Promise<any> {
        if (!this.initialized) await this.init();
        const mapping = this.getLanguageMapping(filePath);
        const langName = mapping?.languageId;
        if (!langName) {
            return null;
        }
        if (typeof (this.backend! as any).getParser === 'function') {
            try {
                return await (this.backend! as any).getParser(langName);
            } catch (error) {
                console.warn(`Failed to retrieve parser for ${filePath}:`, error);
                return null;
            }
        }
        return null;
    }

    public async getLanguageForFile(filePath: string): Promise<any> {
        if (!this.initialized) await this.init();
        const mapping = this.getLanguageMapping(filePath);
        const languageId = mapping?.languageId ?? path.extname(filePath).replace('.', '');
        return this.backend!.getLanguage(languageId);
    }

    public getLanguageId(filePath: string): string {
        return this.resolveLanguageId(filePath);
    }

    public getActiveBackend(): string | undefined {
        return this.activeBackend;
    }

    // NEW: Implement AdaptiveAstManager interface
    async ensureLOD(request: AnalysisRequest): Promise<LODResult> {
        if (!FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)) {
            // Fallback: treat all requests as LOD 3 (full AST)
            const startTime = performance.now();
            // In a real scenario we'd need the content, but for this stub we use placeholder
            await this.parseFile(request.path, ''); 
            const durationMs = performance.now() - startTime;
            
            return {
                path: request.path,
                previousLOD: 0,
                currentLOD: 3,
                requestedLOD: request.minLOD,
                promoted: true,
                durationMs,
                fallbackUsed: true,
                confidence: 1.0
            };
        }
        
        // TODO: Phase 2 - Implement actual LOD promotion logic
        throw new Error('ensureLOD not implemented yet (Phase 2)');
    }
    
    getFileNode(path: string) {
        if (!FeatureFlags.isEnabled(FeatureFlags.UCG_ENABLED)) {
            return undefined;
        }
        // TODO: Phase 2 - Return UCG node
        return undefined;
    }
    
    getCurrentLOD(path: string): LOD_LEVEL {
        // TODO: Phase 2 - Query UCG or FileRecord
        return 0;
    }
    
    promotionStats(): LODPromotionStats {
        return { ...this.lodStats };
    }
    
    async fallbackToFullAST(path: string): Promise<LODResult> {
        const startTime = performance.now();
        // Force full AST parsing
        await this.parseFile(path, '');
        const durationMs = performance.now() - startTime;
        
        return {
            path,
            previousLOD: 0,
            currentLOD: 3,
            requestedLOD: 3,
            promoted: true,
            durationMs,
            fallbackUsed: true,
            confidence: 1.0
        };
    }
    
    invalidate(path: string, cascade: boolean = false): void {
        // TODO: Phase 2 - Implement UCG invalidation
        console.log(`[AstManager] Invalidate ${path}, cascade: ${cascade}`);
    }

    public supportsQueries(): boolean {
        if (!this.backend) return false;
        return this.backend.capabilities.supportsQueries;
    }

    private resolveConfig(overrides?: EngineConfig): EngineConfig {
        const envMode = process.env.SMART_CONTEXT_ENGINE_MODE as EngineConfig['mode'] | undefined;
        const envBackend = process.env.SMART_CONTEXT_PARSER_BACKEND as EngineConfig['parserBackend'] | undefined;
        const envSnapshot = process.env.SMART_CONTEXT_SNAPSHOT_DIR;
        const envRoot = process.env.SMART_CONTEXT_ROOT_PATH || process.env.SMART_CONTEXT_ROOT;

        return {
            mode: overrides?.mode ?? envMode ?? this.engineConfig.mode ?? 'prod',
            parserBackend: overrides?.parserBackend ?? envBackend ?? this.engineConfig.parserBackend ?? 'auto',
            snapshotDir: overrides?.snapshotDir ?? envSnapshot ?? this.engineConfig.snapshotDir,
            rootPath: overrides?.rootPath ?? this.engineConfig.rootPath ?? envRoot ?? process.cwd()
        };
    }

    private getBackendPriority(): Array<NonNullable<EngineConfig['parserBackend']>> {
        const mode = this.engineConfig.mode ?? 'prod';
        const requested = this.engineConfig.parserBackend ?? 'auto';

        if (requested !== 'auto') {
            return [requested];
        }

        switch (mode) {
            case 'test':
                return ['snapshot', 'wasm', 'js'];
            case 'ci':
                return ['wasm', 'js'];
            case 'prod':
            default:
                return ['wasm', 'js'];
        }
    }

    private instantiateBackend(kind: string): AstBackend {
        switch (kind) {
            case 'wasm':
                return new WebTreeSitterBackend();
            case 'js':
                return new JsAstBackend();
            case 'snapshot':
                if (!this.engineConfig.snapshotDir || !this.engineConfig.rootPath) {
                    throw new Error('Snapshot backend requires snapshotDir and rootPath');
                }
                return new SnapshotBackend({
                    snapshotDir: this.engineConfig.snapshotDir,
                    rootPath: this.engineConfig.rootPath
                });
            default:
                throw new Error(`Unknown parser backend: ${kind}`);
        }
    }

    private async initializeBackend(): Promise<void> {
        const candidates = this.getBackendPriority();
        const errors: string[] = [];

        for (const candidate of candidates) {
            try {
                const backend = this.instantiateBackend(candidate);
                await backend.initialize();
                const previousBackend = this.backend;
                this.backend = backend;
                (previousBackend as any)?.dispose?.();
                this.initialized = true;
                this.activeBackend = candidate;
                return;
            } catch (error: any) {
                errors.push(`${candidate}: ${error.message}`);
            }
        }

        throw new Error(`Failed to initialize AST backend. Attempts: ${errors.join('; ')}`);
    }

    private resolveLanguageId(filePath: string): string {
        const mapping = this.getLanguageMapping(filePath);
        if (mapping?.languageId) {
            return mapping.languageId;
        }
        const fallback = path.extname(filePath).replace('.', '');
        if (fallback) {
            return fallback;
        }
        throw new Error(`Unsupported language for ${filePath}`);
    }

    private getLanguageMapping(filePath: string) {
        const ext = path.extname(filePath).toLowerCase();
        return this.languageConfig?.getLanguageMapping(ext);
    }

    public async dispose(): Promise<void> {
        if (this.backend && typeof (this.backend as any).dispose === 'function') {
            (this.backend as any).dispose();
        }
        this.languageConfig?.dispose();
        this.initialized = false;
    }
}
