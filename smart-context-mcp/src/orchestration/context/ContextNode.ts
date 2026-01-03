import { LOD_LEVEL, TopologyInfo } from '../../types.js';

/**
 * Node in the Unified Context Graph.
 * Represents a file and its analysis state.
 */
export class ContextNode {
    public path: string;
    public lod: LOD_LEVEL;
    public lastModified: number;
    public size: number;
    public topology?: TopologyInfo;
    public skeleton?: string;
    public astDocId?: string;
    public dependencies: Set<string>;
    public dependents: Set<string>;
    public lodUpdatedAt: number;
    public metadata: {
        promotions: number;
        lastPromotionDuration: number;
        lastError?: string;
    };
    
    constructor(path: string, lod: LOD_LEVEL = 0) {
        this.path = path;
        this.lod = lod;
        this.lastModified = 0;
        this.size = 0;
        this.dependencies = new Set();
        this.dependents = new Set();
        this.lodUpdatedAt = Date.now();
        this.metadata = { promotions: 0, lastPromotionDuration: 0 };
    }
    
    setTopology(topology: TopologyInfo): void {
        this.topology = topology;
        this.lod = Math.max(this.lod, 1) as LOD_LEVEL;
        this.lodUpdatedAt = Date.now();
        this.metadata.promotions++;
    }
    
    setSkeleton(skeleton: string): void {
        this.skeleton = skeleton;
        this.lod = Math.max(this.lod, 2) as LOD_LEVEL;
        this.lodUpdatedAt = Date.now();
        this.metadata.promotions++;
    }
    
    setAstDoc(docId: string): void {
        this.astDocId = docId;
        this.lod = 3;
        this.lodUpdatedAt = Date.now();
        this.metadata.promotions++;
    }
    
    downgrade(newLod: LOD_LEVEL): void {
        if (newLod < this.lod) {
            this.lod = newLod;
            this.lodUpdatedAt = Date.now();
            if (newLod < 3) this.astDocId = undefined;
            if (newLod < 2) this.skeleton = undefined;
            if (newLod < 1) {
                this.topology = undefined;
                this.dependencies.clear();
            }
        }
    }
    
    addDependency(targetPath: string): void { this.dependencies.add(targetPath); }
    addDependent(sourcePath: string): void { this.dependents.add(sourcePath); }
    removeDependency(targetPath: string): void { this.dependencies.delete(targetPath); }
    removeDependent(sourcePath: string): void { this.dependents.delete(sourcePath); }
}
