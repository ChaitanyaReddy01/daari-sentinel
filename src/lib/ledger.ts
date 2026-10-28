import fs from 'node:fs';
import path from 'node:path';

import { isProduction } from './snapshot';

/**
 * Cost ledger. Locally: appended to data/ledger.jsonl. On Vercel
 * (read-only): entries go to a Redis list, spend to a float counter.
 */

const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');
const REDIS_LIST = 'daari:ledger';
const REDIS_SPEND = 'daari:spend';
const REDIS_LIST_CAP = 10000;

async function redis() {
  const { Redis } = await import('@upstash/redis');
  return Redis.fromEnv();
}

export async function ledgerAppend(entry: Record<string, unknown>): Promise<void> {
  if (!isProduction()) {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
    return;
  }
  const r = await redis();
  const p = r.pipeline();
  p.rpush(REDIS_LIST, JSON.stringify(entry));
  if (typeof entry.estUSD === 'number' && Number.isFinite(entry.estUSD)) {
    p.incrbyfloat(REDIS_SPEND, entry.estUSD);
  }
  p.ltrim(REDIS_LIST, 0, REDIS_LIST_CAP - 1);
  await p.exec();
}

/** Total estimated spend across every recorded call. */
export async function ledgerSpendTotal(): Promise<number> {
  if (!isProduction()) {
    let total = 0;
    let raw: string;
    try {
      raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    } catch {
      return 0;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { estUSD?: unknown };
        if (typeof entry.estUSD === 'number' && Number.isFinite(entry.estUSD)) {
          total += entry.estUSD;
        }
      } catch {
        // Skip malformed ledger lines.
      }
    }
    return total;
  }
  const r = await redis();
  const v = await r.get<number | string>(REDIS_SPEND);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  return 0;
}
