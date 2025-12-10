import { SearchCluster } from "../../types/cluster.js";

export class ClusterRanker {
    rank(clusters: SearchCluster[]): SearchCluster[] {
        return clusters
            .map(cluster => ({ cluster, score: this.computeScore(cluster) }))
            .sort((a, b) => b.score - a.score)
            .map(entry => entry.cluster);
    }

    private computeScore(cluster: SearchCluster): number {
        const seedScore = cluster.seeds.length
            ? Math.max(...cluster.seeds.map(seed => seed.matchScore))
            : 0;
        const colocatedBonus = cluster.related.colocated.data.length * 0.05;
        const siblingBonus = cluster.related.siblings.data.length * 0.03;
        const tokenPenalty = cluster.metadata.tokenEstimate / 5000;
        return seedScore + colocatedBonus + siblingBonus - tokenPenalty;
    }
}
