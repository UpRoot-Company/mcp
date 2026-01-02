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
  static create(args: {
    intentText: string;
    targetSample?: string;
    includeImpact: boolean;
    dryRun: boolean;
    editCount?: number;
    batchMode?: boolean;
  }): ChangeBudget {
    const metrics = analyzeQuery(args.targetSample ?? args.intentText);
    const strong = metrics.strong;
    const editCount = Math.max(1, args.editCount ?? 1);
    const isBatch = Boolean(args.batchMode) || editCount > 1;

    let maxMatchAttempts = strong ? 3 : 1;
    let allowNormalization = strong;
    let allowLevenshtein = strong;
    const maxLevenshteinTargetLength = 120;
    const allowImpact = args.includeImpact;
    const maxDiffBytes = 200_000;

    if (isBatch) {
      maxMatchAttempts = 1;
      allowNormalization = false;
      allowLevenshtein = false;
    }

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
