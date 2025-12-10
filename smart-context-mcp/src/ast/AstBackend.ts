export interface AstDocument {
    rootNode: any; // Using 'any' for now to support different backend implementations, but primarily Tree-sitter Tree
    languageId: string;
    dispose?: () => void;
}

export interface AstBackend {
    name: string;
    capabilities: {
        supportsComments: boolean;
        supportsTypeAnnotations: boolean;
        supportsQueries: boolean;
        nodeTypeNormalization: 'tree-sitter' | 'babel' | 'native';
    };
    
    initialize(): Promise<void>;
    
    parseFile(
        absPath: string,
        content: string,
        languageHint?: string
    ): Promise<AstDocument>;

    getLanguage(languageId: string): Promise<any>; // Returns language object (e.g. tree-sitter Language)

    getParser?(languageId: string): Promise<any>;
}
