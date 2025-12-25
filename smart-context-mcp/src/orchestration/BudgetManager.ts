import { BudgetProfile, ResourceBudget, ResourceUsage } from '../types.js';

export interface ProjectStats {
  fileCount?: number;
}

export interface BudgetInputs {
  category: 'navigate' | 'understand';
  queryLength: number;
  tokenCount: number;
  strongQuery: boolean;
  includeGraph?: boolean;
  includeHotSpots?: boolean;
  profile?: BudgetProfile;
  projectStats?: ProjectStats;
}

const DEFAULTS: Record<BudgetProfile, ResourceBudget> = {
  safe: {
    maxCandidates: 600,
    maxFilesRead: 200,
    maxBytesRead: 2_000_000,
    maxParseTimeMs: 1500,
    maxGraphNodes: 800,
    profile: 'safe'
  },
  balanced: {
    maxCandidates: 1500,
    maxFilesRead: 500,
    maxBytesRead: 6_000_000,
    maxParseTimeMs: 3000,
    maxGraphNodes: 2000,
    profile: 'balanced'
  },
  deep: {
    maxCandidates: 4000,
    maxFilesRead: 1500,
    maxBytesRead: 20_000_000,
    maxParseTimeMs: 8000,
    maxGraphNodes: 8000,
    profile: 'deep'
  }
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const envNumber = (key: string): number | undefined => {
  const raw = process.env[key];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readProfile = (fallback: BudgetProfile): BudgetProfile => {
  const raw = process.env.SMART_CONTEXT_BUDGET_PROFILE;
  if (raw === 'safe' || raw === 'balanced' || raw === 'deep') return raw;
  return fallback;
};

export class BudgetManager {
  static create(inputs: BudgetInputs): ResourceBudget {
    const baseProfile = inputs.profile ?? (process.env.SMART_CONTEXT_SAFE_MODE === 'false' ? 'balanced' : 'safe');
    const profile = readProfile(baseProfile);
    const seed = { ...DEFAULTS[profile] };

    const projectScale = inputs.projectStats?.fileCount
      ? clamp(1 - Math.log10(Math.max(10, inputs.projectStats.fileCount)) * 0.12, 0.4, 1)
      : 1;

    const queryBoost = inputs.strongQuery || inputs.queryLength >= 12 || inputs.tokenCount >= 3 ? 1.15 : 0.85;
    const categoryBoost = inputs.category === 'understand' ? 0.9 : 1;

    const maxCandidates = Math.floor(seed.maxCandidates * projectScale * queryBoost * categoryBoost);
    const maxFilesRead = Math.floor(seed.maxFilesRead * projectScale * queryBoost);
    const maxBytesRead = Math.floor(seed.maxBytesRead * projectScale * queryBoost);
    const maxParseTimeMs = Math.floor(seed.maxParseTimeMs * projectScale * queryBoost);

    return {
      ...seed,
      maxCandidates: clamp(maxCandidates, 100, seed.maxCandidates),
      maxFilesRead: clamp(maxFilesRead, 50, seed.maxFilesRead),
      maxBytesRead: clamp(maxBytesRead, 500_000, seed.maxBytesRead),
      maxParseTimeMs: clamp(maxParseTimeMs, 500, seed.maxParseTimeMs),
      profile
    };
  }

  static createUsage(): ResourceUsage {
    return { filesRead: 0, bytesRead: 0, parseTimeMs: 0 };
  }
}
