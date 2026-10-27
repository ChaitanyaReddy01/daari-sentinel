/**
 * Muse Spark configuration. Key-free: values come from the environment with
 * documented defaults, so estimates and cached reads never need MODEL_API_KEY.
 */

export const MUSE_SPARK_MODEL =
  process.env.MUSE_SPARK_MODEL?.trim() || 'muse-spark-1.3-contributor';

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof EFFORTS)[number];

function parseEffort(value: string | undefined): ReasoningEffort {
  if (value && (EFFORTS as readonly string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  return 'medium';
}

export const REASONING_EFFORT = parseEffort(process.env.REASONING_EFFORT);

/**
 * Reasoning shares the output budget, so this must leave room for both the
 * private reasoning tokens and the visible answer. Per the docs, at least
 * 4000 for Muse Spark video requests.
 */
export const SPARK_MAX_OUTPUT_TOKENS = 4000;

export interface TokenPrices {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
  /** Date the prices were copied from the pricing page (YYYY-MM-DD). */
  asOf: string;
}

/** Per-million-token prices from https://dev.meta.ai/docs/pricing-rate-limits. */
const SPARK_PRICES: Record<string, TokenPrices> = {
  'muse-spark-1.3': {
    inputPer1M: 1.25,
    cachedInputPer1M: 0.15,
    outputPer1M: 4.25,
    asOf: '2026-10-27',
  },
  'muse-spark-1.3-contributor': {
    inputPer1M: 0.1,
    cachedInputPer1M: 0.002,
    outputPer1M: 0.2,
    asOf: '2026-10-27',
  },
};

/** Prices for a model id; unknown ids fall back to standard pricing. */
export function pricesFor(model: string): TokenPrices {
  return (
    SPARK_PRICES[model] ?? {
      inputPer1M: 1.25,
      cachedInputPer1M: 0.15,
      outputPer1M: 4.25,
      asOf: '2026-10-27',
    }
  );
}

export function verdictCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const p = pricesFor(model);
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (freshInput * p.inputPer1M +
      cachedInputTokens * p.cachedInputPer1M +
      outputTokens * p.outputPer1M) /
    1_000_000
  );
}
