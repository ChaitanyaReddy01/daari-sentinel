import fs from 'node:fs';
import path from 'node:path';

import { verdictCostUSD } from './config';
import { PROMPT_VERSION, type Verdict } from './verdict';

/**
 * Key-free verdict cache + estimates. Reading a cached verdict or an estimate
 * never needs MODEL_API_KEY, so the UI can probe freely.
 */

export interface VerdictUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface VerdictCachedResult {
  promptVersion: number;
  model: string;
  verdict: Verdict;
  usage: VerdictUsage;
  estUSD: number;
}

const VERDICT_DIR = path.join(process.cwd(), 'data', 'cache', 'verdict');
const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');

export function verdictCachePath(hash: string): string {
  return path.join(VERDICT_DIR, `${hash}.json`);
}

/** Read a cached verdict. Version mismatch counts as a miss (re-runs it). */
export function readVerdictCache(hash: string): VerdictCachedResult | null {
  try {
    const raw = fs.readFileSync(verdictCachePath(hash), 'utf8');
    const parsed = JSON.parse(raw) as VerdictCachedResult;
    if (!parsed || parsed.promptVersion !== PROMPT_VERSION || !parsed.verdict) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Median estUSD of past verdict calls for this model. With no history, scale
 * from the clip length: observed ~30 input tokens/frame plus prompt text
 * (~500), ~1,500 output tokens including reasoning.
 */
const FALLBACK_INPUT_TOKENS_PER_FRAME = 30;
const FALLBACK_PROMPT_TOKENS = 500;
const FALLBACK_OUTPUT_TOKENS = 1_500;

export function estimateVerdictCost(model: string, frameCount: number): number {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    const costs: number[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as {
          kind?: unknown;
          model?: unknown;
          estUSD?: unknown;
        };
        if (
          entry.kind === 'verdict' &&
          entry.model === model &&
          typeof entry.estUSD === 'number' &&
          Number.isFinite(entry.estUSD)
        ) {
          costs.push(entry.estUSD);
        }
      } catch {
        // Skip malformed ledger lines.
      }
    }
    if (costs.length > 0) {
      costs.sort((a, b) => a - b);
      return costs[Math.floor(costs.length / 2)];
    }
  } catch {
    // No ledger yet; fall through to the assumed-usage estimate.
  }
  return verdictCostUSD(
    model,
    FALLBACK_INPUT_TOKENS_PER_FRAME * Math.max(0, frameCount) + FALLBACK_PROMPT_TOKENS,
    FALLBACK_OUTPUT_TOKENS,
  );
}
