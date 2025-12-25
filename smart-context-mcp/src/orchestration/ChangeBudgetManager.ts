import { analyzeQuery } from '../engine/search/QueryMetrics.js';

export interface ChangeBudget {
  maxMatchAttempts: number;
  allowNormalization: boolean;
  allowLevenshtein: boolean;
  maxLevenshteinTargetLength: number;
  allowImpact: boolean;
  maxDiffBytes: number;
}

export class ChangeBudgetManager {
  static create(args: { intentText: string; targetSample?: string; includeImpact: boolean; dryRun: boolean }): ChangeBudget {
    const metrics = analyzeQuery(args.targetSample ?? args.intentText);
    const strong = metrics.strong;

    const maxMatchAttempts = strong ? 3 : 1;
    const allowNormalization = strong;
    const allowLevenshtein = strong;
    const maxLevenshteinTargetLength = 120;
    const allowImpact = args.includeImpact;
    const maxDiffBytes = 200_000;

    return {
      maxMatchAttempts,
      allowNormalization,
      allowLevenshtein,
      maxLevenshteinTargetLength,
      allowImpact,
      maxDiffBytes
    };
  }
}
