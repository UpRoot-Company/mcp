import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { ContextNode } from './ContextNode.js';
import { LOD_LEVEL, AnalysisRequest, LODResult, TopologyInfo } from '../../types.js';
import { TopologyScanner } from '../../ast/topology/TopologyScanner.js';
import { SkeletonGenerator } from '../../ast/SkeletonGenerator.js';
import { SkeletonCache } from '../../ast/SkeletonCache.js';
import { AstManager } from '../../ast/AstManager.js';
import { FeatureFlags } from '../../config/FeatureFlags.js';
import { ModuleResolver } from '../../ast/ModuleResolver.js';
import { FileWatcher } from './FileWatcher.js';
import { AdaptiveFlowMetrics } from '../../utils/AdaptiveFlowMetrics.js';

/**
 * Unified Context Graph: Centralized state for all file analysis.
 */
export class UnifiedContextGraph {
    private nodes: Map<string, ContextNode>;
    private lruQueue: string[];
    private maxNodes: number;
    private topologyScanner: TopologyScanner;
    private skeletonGenerator: SkeletonGenerator;
    private skeletonCache: SkeletonCache;
    private astManager: AstManager;
    private moduleResolver: ModuleResolver;
    private rootPath: string;
    private fileWatcher?: FileWatcher;
    private persistPath: string;
    private saveTimeout?: NodeJS.Timeout;
    
    private stats = {
        promotions: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 },
        evictions: 0,
        cascadeInvalidations: 0
    };
    
    constructor(rootPath: string, maxNodes: number = 5000, enableWatcher: boolean = false) {
        this.nodes = new Map();
        this.lruQueue = [];
        this.maxNodes = maxNodes;
        this.rootPath = rootPath;
        this.topologyScanner = new TopologyScanner(rootPath);
        this.skeletonGenerator = new SkeletonGenerator();
        this.skeletonCache = new SkeletonCache(rootPath);
        this.astManager = AstManager.getInstance();
        this.moduleResolver = new ModuleResolver(rootPath);
        this.persistPath = path.join(rootPath, '.smart-context', 'data', 'ucg.json');
        
        if (enableWatcher) {
            this.fileWatcher = new FileWatcher(this, rootPath);
            this.fileWatcher.start();
        }

        this.load().catch(() => {});
    }

    private async save() {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            try {
                const data = {
                    nodes: Array.from(this.nodes.entries()).map(([path, node]) => ({
                        path,
                        lod: node.lod,
                        topology: node.topology,
                        structure: node.structure,
                        lastModified: node.lastModified,
                        size: node.size,
                        dependencies: Array.from(node.dependencies),
                        dependents: Array.from(node.dependents)
                    })),
                    lruQueue: this.lruQueue
                };
                if (!fs.existsSync(path.dirname(this.persistPath))) {
                    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
                }
                fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
            } catch (e) {
                console.error('[UCG] Failed to save graph state:', e);
            }
        }, 2000);
    }

    private async load() {
        try {
            if (!fs.existsSync(this.persistPath)) return;
            const content = fs.readFileSync(this.persistPath, 'utf-8');
            const data = JSON.parse(content);
            
            for (const n of data.nodes) {
                const node = new ContextNode(n.path, n.lod);
                node.topology = n.topology;
                node.structure = n.structure;
                node.lastModified = n.lastModified;
                node.size = n.size;
                node.dependencies = new Set(n.dependencies);
                node.dependents = new Set(n.dependents);
                this.nodes.set(n.path, node);
            }
            this.lruQueue = data.lruQueue || [];
            console.log(`[UCG] Loaded ${this.nodes.size} nodes from persistence.`);
        } catch (e) {
            console.error('[UCG] Failed to load graph state:', e);
        }
        this.reportMetrics();
    }
    
    async ensureLOD(request: AnalysisRequest): Promise<LODResult> {
        const startTime = performance.now();
        let node = this.nodes.get(request.path);
        if (!node) {
            node = new ContextNode(request.path, 0);
            this.nodes.set(request.path, node);
        }
        this.updateLRU(request.path);
        
        const previousLOD = node.lod;
        if (node.lod >= request.minLOD && !request.force) {
            return { path: request.path, previousLOD, currentLOD: node.lod, requestedLOD: request.minLOD, promoted: false, durationMs: performance.now() - startTime, fallbackUsed: false, confidence: 1.0 };
        }
        
        try {
            let fallbackUsed = false;
            let confidence = 1.0;
            for (let targetLOD = node.lod + 1; targetLOD <= request.minLOD; targetLOD++) {
                const beforePromotion = node.lod;
                if (targetLOD === 1) {
                    const res = await this.promoteToLOD1(node);
                    fallbackUsed = res.fallbackUsed;
                    confidence = res.confidence;
                    this.stats.promotions.l0_to_l1++;
                } else if (targetLOD === 2) {
                    await this.promoteToLOD2(node);
                    this.stats.promotions.l1_to_l2++;
                } else if (targetLOD === 3) {
                    await this.promoteToLOD3(node);
                    this.stats.promotions.l2_to_l3++;
                }
                if (node.lod > beforePromotion) {
                    AdaptiveFlowMetrics.recordPromotion(beforePromotion, node.lod);
                }
            }
            this.evictIfNeeded();
            this.save();
            this.reportMetrics();
            return { path: request.path, previousLOD, currentLOD: node.lod, requestedLOD: request.minLOD, promoted: true, durationMs: performance.now() - startTime, fallbackUsed, confidence };
        } catch (error) {
            node.metadata.lastError = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }
    
    private async promoteToLOD1(node: ContextNode) {
        if (!FeatureFlags.isEnabled(FeatureFlags.TOPOLOGY_SCANNER_ENABLED)) return { fallbackUsed: true, confidence: 1.0 };
        const topology = await this.topologyScanner.extract(node.path);
        node.setTopology(topology);
        const stats = fs.statSync(node.path);
        node.lastModified = stats.mtimeMs;
        node.size = stats.size;
        this.buildDependencyEdges(node, topology);
        return { fallbackUsed: topology.fallbackUsed, confidence: topology.confidence };
    }
    
    private async promoteToLOD2(node: ContextNode) {
        const content = fs.readFileSync(node.path, 'utf-8');
        const skeleton = await this.skeletonCache.getSkeleton(
            node.path,
            { detailLevel: 'standard' },
            async (f, opts) => {
                return this.skeletonGenerator.generateSkeleton(f, content, opts);
            }
        );
        const structure = await this.skeletonGenerator.generateStructureJson(node.path, content);
        node.setSkeleton(skeleton, structure);
        this.stats.promotions.l1_to_l2++;
    }
    
    private async promoteToLOD3(node: ContextNode) {
        const content = fs.readFileSync(node.path, 'utf-8');
        await this.astManager.parseFile(node.path, content);
        node.setAstDoc("ast:" + node.path + ":" + Date.now());
    }
    
    private buildDependencyEdges(node: ContextNode, topology: TopologyInfo) {
        for (const dep of node.dependencies) {
            this.nodes.get(dep)?.removeDependent(node.path);
        }
        node.dependencies.clear();
        for (const imp of topology.imports) {
            const resolved = this.moduleResolver.resolve(node.path, imp.source);
            if (resolved) {
                node.addDependency(resolved);
                let depNode = this.nodes.get(resolved);
                if (!depNode) {
                    depNode = new ContextNode(resolved, 0);
                    this.nodes.set(resolved, depNode);
                }
                depNode.addDependent(node.path);
            }
        }
    }
    
    invalidate(path: string, cascade: boolean = true) {
        const node = this.nodes.get(path);
        if (!node) return;
        node.downgrade(0);
        if (cascade) {
            for (const dependentPath of node.dependents) {
                const dependent = this.nodes.get(dependentPath);
                if (dependent && dependent.lod >= 2) {
                    dependent.downgrade(1);
                    this.stats.cascadeInvalidations++;
                }
            }
        }
        this.save();
        this.reportMetrics();
    }
    
    getNode(path: string) { return this.nodes.get(path); }

    removeNode(path: string): void {
        const node = this.nodes.get(path);
        if (!node) return;
        
        // Remove edges
        for (const dep of node.dependencies) {
            this.nodes.get(dep)?.removeDependent(path);
        }
        for (const dependent of node.dependents) {
            this.nodes.get(dependent)?.removeDependency(path);
        }
        
        // Remove from LRU
        const idx = this.lruQueue.indexOf(path);
        if (idx !== -1) this.lruQueue.splice(idx, 1);
        
        this.nodes.delete(path);
        this.save();
        this.reportMetrics();
    }

    async dispose(): Promise<void> {
        if (this.fileWatcher) {
            await this.fileWatcher.stop();
        }
        this.clear();
    }
    
    private updateLRU(path: string) {
        const idx = this.lruQueue.indexOf(path);
        if (idx !== -1) this.lruQueue.splice(idx, 1);
        this.lruQueue.push(path);
    }
    
    private evictIfNeeded() {
        while (this.nodes.size > this.maxNodes && this.lruQueue.length > 0) {
            const evictPath = this.lruQueue.shift()!;
            const node = this.nodes.get(evictPath);
            if (node) {
                for (const dep of node.dependencies) this.nodes.get(dep)?.removeDependent(evictPath);
                for (const dependent of node.dependents) this.nodes.get(dependent)?.removeDependency(evictPath);
                this.nodes.delete(evictPath);
                this.stats.evictions++;
            }
        }
        this.reportMetrics();
    }
    
    getStats() {
        return { nodes: this.nodes.size, maxNodes: this.maxNodes, ...this.stats, memoryEstimateMB: (this.nodes.size * 2) / 1024 };
    }
    
    clear() {
        this.nodes.clear();
        this.lruQueue = [];
        this.stats = { promotions: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 }, evictions: 0, cascadeInvalidations: 0 };
        this.reportMetrics();
    }

    private reportMetrics(): void {
        const stats = this.getStats();
        AdaptiveFlowMetrics.captureUcgSnapshot({
            node_count: stats.nodes,
            evictions: stats.evictions,
            cascade_invalidations: stats.cascadeInvalidations,
            memory_estimate_mb: stats.memoryEstimateMB ?? 0
        });
    }
}
