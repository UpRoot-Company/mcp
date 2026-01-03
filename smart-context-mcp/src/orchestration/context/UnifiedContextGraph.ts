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
        
        if (enableWatcher) {
            this.fileWatcher = new FileWatcher(this, rootPath);
            this.fileWatcher.start();
        }
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
            }
            this.evictIfNeeded();
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
        const skeleton = await this.skeletonCache.getSkeleton(
            node.path,
            { detailLevel: 'standard' },
            async (f, opts) => {
                const content = fs.readFileSync(f, 'utf-8');
                return this.skeletonGenerator.generateSkeleton(f, content, opts);
            }
        );
        node.setSkeleton(skeleton);
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
    }
    
    getStats() {
        return { nodes: this.nodes.size, maxNodes: this.maxNodes, ...this.stats, memoryEstimateMB: (this.nodes.size * 2) / 1024 };
    }
    
    clear() {
        this.nodes.clear();
        this.lruQueue = [];
        this.stats = { promotions: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 }, evictions: 0, cascadeInvalidations: 0 };
    }
}
