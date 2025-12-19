import { IndexDatabase } from '../../indexing/IndexDatabase.js';
import { SymbolInfo, BaseSymbolInfo, DefinitionSymbol } from '../../types.js';

export interface GhostSymbol {
    name: string;
    type: string;
    signature?: string;
    originalPath: string;
    deletedAt: number;
}

export class GhostArcheology {
    constructor(private readonly db: IndexDatabase) {}

    /**
     * Registers symbols as ghosts when a file is deleted.
     */
    public async registerGhostsFromFile(relativePath: string, symbols: SymbolInfo[]): Promise<void> {
        const deletedAt = Date.now();
        for (const symbol of symbols) {
            // Only DefinitionSymbols usually have signatures
            const signature = (symbol as DefinitionSymbol).signature;
            
            this.db.addGhost({
                name: symbol.name,
                lastSeenPath: relativePath,
                type: symbol.type,
                lastKnownSignature: signature ?? null,
                deletedAt
            });
        }
    }

    /**
     * Checks if a symbol name belongs to a deleted file.
     */
    public findGhost(name: string): GhostSymbol | null {
        const row = this.db.findGhost(name);
        if (!row) return null;
        
        return {
            name: row.name,
            type: row.type,
            signature: row.lastKnownSignature,
            originalPath: row.lastSeenPath,
            deletedAt: row.deletedAt
        } as GhostSymbol;
    }

    /**
     * Lists all current ghosts.
     */
    public listGhosts(): GhostSymbol[] {
        const ghosts = this.db.listGhosts();
        return ghosts.map(row => ({
            name: row.name,
            type: row.type,
            signature: row.lastKnownSignature,
            originalPath: row.lastSeenPath,
            deletedAt: row.deletedAt
        })) as GhostSymbol[];
    }
}
