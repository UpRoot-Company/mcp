import * as fs from 'fs';
import * as path from 'path';
import { AstManager } from '../ast/AstManager.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { ModuleResolver } from '../ast/ModuleResolver.js';
import { CallGraphBuilder } from '../ast/CallGraphBuilder.js';
import { TypeDependencyTracker } from '../ast/TypeDependencyTracker.js';
import { QueryParser } from '../engine/ClusterSearch/QueryParser.js';
import { SeedFinder } from '../engine/ClusterSearch/SeedFinder.js';
import { ClusterBuilder } from '../engine/ClusterSearch/ClusterBuilder.js';
import { ClusterSearchEngine } from '../engine/ClusterSearch/index.js';
import { ExpansionState } from '../types/cluster.js';

const testDir = path.join(process.cwd(), 'src', 'tests', 'cluster_search_env');

const writeFile = (relativePath: string, content: string) => {
    const absPath = path.join(testDir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
};

describe('ClusterSearch Phase 2 Components', () => {
    let symbolIndex: SymbolIndex;
    let moduleResolver: ModuleResolver;
    let callGraphBuilder: CallGraphBuilder;
    let typeDependencyTracker: TypeDependencyTracker;

    beforeAll(async () => {
        await AstManager.getInstance().init();

        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        fs.mkdirSync(testDir, { recursive: true });

        writeFile('services/user_service.ts', `export class UserService {
    public createUser(name: string) {
        return name.toUpperCase();
    }

    public deleteUser(name: string) {
        return name.toLowerCase();
    }
}

export function auditLog(message: string) {
    return message;
}

export const USER_ROLE = 'admin';
`);

        writeFile('controllers/user_controller.ts', `import { UserService } from "../services/user_service";

export function bootstrapUser(name: string) {
    const service = new UserService();
    service.createUser(name);
    return service;
}

export function teardownUser(name: string) {
    const service = new UserService();
    service.deleteUser(name);
    return service;
}
`);
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        const generator = new SkeletonGenerator();
        symbolIndex = new SymbolIndex(testDir, generator, []);
        moduleResolver = new ModuleResolver(testDir);
        callGraphBuilder = new CallGraphBuilder(testDir, symbolIndex, moduleResolver);
        typeDependencyTracker = new TypeDependencyTracker(testDir, symbolIndex);
    });

    it('parses filters and intent from query strings', () => {
        const parser = new QueryParser();
        const parsed = parser.parse('function:createUser usages:deleteUser in:services');

        expect(parsed.intent).toBe('usage');
        expect(parsed.filters.type).toEqual(['function', 'method']);
        expect(parsed.filters.file).toBe('services');
        expect(parsed.terms).toEqual(['createUser', 'deleteUser']);
    });

    it('returns highest scoring seeds first', async () => {
        const parser = new QueryParser();
        const parsed = parser.parse('createUser');
        const seedFinder = new SeedFinder(symbolIndex);
        const seeds = await seedFinder.findSeeds(parsed, 5);

        expect(seeds.length).toBeGreaterThan(0);
        expect(seeds[0].symbol.name).toBe('createUser');
        expect(seeds[0].filePath.replace(/\\/g, '/')).toBe('services/user_service.ts');
    });

    it('populates colocated and sibling relations for a seed', async () => {
        const allSymbols = await symbolIndex.getAllSymbols();
        const userFileSymbols = allSymbols.get('services/user_service.ts');
        expect(userFileSymbols).toBeDefined();
        const createUserSymbol = userFileSymbols!.find(symbol => symbol.name === 'createUser');
        expect(createUserSymbol).toBeDefined();

        const builder = new ClusterBuilder(testDir, symbolIndex, callGraphBuilder, typeDependencyTracker);
        const cluster = await builder.buildCluster({
            filePath: 'services/user_service.ts',
            symbol: createUserSymbol!,
            matchType: 'exact',
            matchScore: 1
        });

        expect(cluster.related.colocated.state).toBe(ExpansionState.LOADED);
        expect(cluster.related.colocated.data.map(entry => entry.symbolName)).toEqual(
            expect.arrayContaining(['UserService', 'auditLog', 'USER_ROLE'])
        );
        expect(cluster.related.siblings.state).toBe(ExpansionState.LOADED);
        expect(cluster.related.siblings.data.map(entry => entry.symbolName)).toContain('deleteUser');
    });

    it('supports eager callers expansion when requested', async () => {
        const allSymbols = await symbolIndex.getAllSymbols();
        const userFileSymbols = allSymbols.get('services/user_service.ts');
        const createUserSymbol = userFileSymbols!.find(symbol => symbol.name === 'createUser');
        const builder = new ClusterBuilder(testDir, symbolIndex, callGraphBuilder, typeDependencyTracker);
        const cluster = await builder.buildCluster({
            filePath: 'services/user_service.ts',
            symbol: createUserSymbol!,
            matchType: 'exact',
            matchScore: 1
        }, {
            expandRelationships: { callers: true }
        });

        expect(cluster.related.callers.state).not.toBe(ExpansionState.NOT_LOADED);
    });

    it('returns ranked clusters with recommended expansions', async () => {
        const engine = new ClusterSearchEngine({
            rootPath: testDir,
            symbolIndex,
            callGraphBuilder,
            typeDependencyTracker
        });
        const response = await engine.search('createUser');

        expect(response.clusters.length).toBeGreaterThan(0);
        const [cluster] = response.clusters;
        expect(cluster.related.callers.state).toBe(ExpansionState.NOT_LOADED);
        expect(response.expansionHints.recommendedExpansions).toEqual(
            expect.arrayContaining([`${cluster.clusterId}:callers`, `${cluster.clusterId}:callees`, `${cluster.clusterId}:typeFamily`])
        );
        expect(cluster.metadata.clusterType).toBe('module-boundary');
    });
});
