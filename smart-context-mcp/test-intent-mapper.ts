#!/usr/bin/env ts-node
/**
 * Quick test script for IntentToSymbolMapper
 */

import { IntentToSymbolMapper } from './src/engine/IntentToSymbolMapper';
import { SymbolEmbeddingIndex } from './src/indexing/SymbolEmbeddingIndex';
import { SymbolVectorRepository } from './src/indexing/SymbolVectorRepository';
import { CodeSymbol } from './src/types';

async function main() {
    console.log('Testing IntentToSymbolMapper...\n');

    // Create mock dependencies
    const symbolRepo = new SymbolVectorRepository({
        dbPath: ':memory:',
        embeddingDimensions: 384,
    });

    await symbolRepo.initialize();

    const embeddingIndex = new SymbolEmbeddingIndex(symbolRepo, {
        cacheSize: 100,
        batchSize: 10,
    });

    await embeddingIndex.initialize();

    // Create mapper
    const mapper = new IntentToSymbolMapper(embeddingIndex);

    // Test 1: Parse Intent - Function query
    console.log('Test 1: Parse Intent - "function to calculate tax"');
    const intent1 = mapper.parseIntent('function to calculate tax');
    console.log('  Symbol Types:', intent1.symbolTypes);
    console.log('  Keywords:', intent1.keywords);
    console.log('  Confidence:', intent1.confidence);
    console.assert(intent1.symbolTypes.includes('function'), 'Should detect function');
    console.assert(intent1.keywords.includes('calculate'), 'Should extract "calculate"');
    console.assert(intent1.keywords.includes('tax'), 'Should extract "tax"');
    console.assert(intent1.confidence > 0.5, 'Confidence should be > 0.5');
    console.log('  ✅ PASS\n');

    // Test 2: Parse Intent - Class query
    console.log('Test 2: Parse Intent - "class for user management"');
    const intent2 = mapper.parseIntent('class for user management');
    console.log('  Symbol Types:', intent2.symbolTypes);
    console.log('  Keywords:', intent2.keywords);
    console.log('  Confidence:', intent2.confidence);
    console.assert(intent2.symbolTypes.includes('class'), 'Should detect class');
    console.assert(intent2.keywords.includes('user'), 'Should extract "user"');
    console.assert(intent2.keywords.includes('management'), 'Should extract "management"');
    console.log('  ✅ PASS\n');

    // Test 3: Low confidence - empty query
    console.log('Test 3: Low Confidence - Empty query');
    const intent3 = mapper.parseIntent('');
    console.log('  Confidence:', intent3.confidence);
    console.assert(intent3.confidence < 0.5, 'Empty query should have low confidence');
    console.log('  ✅ PASS\n');

    // Test 4: Low confidence - only stop words
    console.log('Test 4: Low Confidence - Only stop words "the a an is"');
    const intent4 = mapper.parseIntent('the a an is are');
    console.log('  Keywords:', intent4.keywords);
    console.log('  Confidence:', intent4.confidence);
    console.assert(intent4.keywords.length === 0, 'Should have no keywords');
    console.assert(intent4.confidence < 0.5, 'Stop words only should have low confidence');
    console.log('  ✅ PASS\n');

    // Test 5: Map to Symbols - with mock data
    console.log('Test 5: Map to Symbols - "calculate price"');
    
    // Add some test symbols
    const testSymbols: CodeSymbol[] = [
        {
            name: 'calculateTotalPrice',
            type: 'function',
            filePath: '/test/price.ts',
            location: { start: { line: 1, column: 0 }, end: { line: 5, column: 0 } },
        },
        {
            name: 'PriceCalculator',
            type: 'class',
            filePath: '/test/calculator.ts',
            location: { start: { line: 1, column: 0 }, end: { line: 10, column: 0 } },
        },
        {
            name: 'getPrice',
            type: 'method',
            filePath: '/test/product.ts',
            location: { start: { line: 1, column: 0 }, end: { line: 3, column: 0 } },
        },
    ];

    for (const symbol of testSymbols) {
        await embeddingIndex.indexSymbol(symbol);
    }

    const results = await mapper.mapToSymbols('function to calculate price', {
        maxResults: 5,
        minConfidence: 0.3,
    });

    console.log('  Results count:', results.length);
    console.log('  Results:');
    results.forEach(r => {
        console.log(`    - ${r.symbol.name} (${r.symbol.type}) - score: ${r.relevanceScore.toFixed(3)}`);
    });
    console.assert(results.length > 0, 'Should return results');
    console.log('  ✅ PASS\n');

    // Test 6: Low confidence rejection
    console.log('Test 6: Low Confidence Rejection - "the a is"');
    const lowConfResults = await mapper.mapToSymbols('the a is', {
        maxResults: 5,
        minConfidence: 0.3,
    });
    console.log('  Results count:', lowConfResults.length);
    console.assert(lowConfResults.length === 0, 'Should return empty for low confidence');
    console.log('  ✅ PASS\n');

    // Test 7: Configuration
    console.log('Test 7: Get Configuration');
    const config = mapper.getConfig();
    console.log('  Config:', config);
    console.assert(config.maxResults === 10, 'Default maxResults should be 10');
    console.assert(config.minConfidence === 0.3, 'Default minConfidence should be 0.3');
    console.assert(config.enableExpansion === true, 'Default enableExpansion should be true');
    console.log('  ✅ PASS\n');

    console.log('✅ All tests passed!');
}

main().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
});
