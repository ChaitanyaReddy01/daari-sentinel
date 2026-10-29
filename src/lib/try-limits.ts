import { ledgerAppend } from './ledger';

/**
 * Cost and abuse guards for /try (try-your-own-clip). All state lives in
 * Upstash Redis; the flow refuses to run without it.
 *
 * - TRY_IT_ENABLED=true kill switch (default off).
 * - Per IP: max 3 tries per 24 h (fixed window from first try).
 * - Global: $2.00/day of real /try cost, reset at midnight ET.
 * - tryId state machine: created(0) → detected(1) → verdict(2) → assessed(3)
 *   → finished(4). Each step checks IP ownership, exact order, no repeats.
 */

export const TRY_DAILY_BUDGET_USD = 2;
export const TRY_MAX_PER_IP = 3;
const TRY_TTL_SECONDS = 3600;
const IP_WINDOW_SECONDS = 86400;

/** Kill switch / budget / quota: the client shows the message (HTTP 403). */
export class TryBlockedError extends Error {}

/** Bad tryId, wrong session, out-of-order steps (HTTP 400). */
export class TryClientError extends Error {}

/** Map a guard error to its HTTP status (default 500 for model/blob failures). */
export function tryErrorStatus(err: unknown): number {
  if (err instanceof TryBlockedError) return 403;
  if (err instanceof TryClientError) return 400;
  return 500;
}

async function redis() {
  const { Redis } = await import('@upstash/redis');
  return Redis.fromEnv();
}

/** Kill switch. Anything but the string 'true' blocks the whole flow. */
export function tryEnabled(): boolean {
  return process.env.TRY_IT_ENABLED === 'true';
}

export function assertTryEnabled(): void {
  if (!tryEnabled()) {
    throw new TryBlockedError('Trying your own clip is currently disabled. Watch the demo instead.');
  }
}

/** Today's date key in America/New_York (budget resets at midnight ET). */
export function etDayKey(when = new Date()): string {
  return when.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function tryBudgetKey(day = etDayKey()): string {
  return `daari:try:spend:${day}`;
}

/** Real /try spend so far today. */
export async function trySpendToday(): Promise<number> {
  const r = await redis();
  const v = await r.get<number | string>(tryBudgetKey());
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  return 0;
}

export const BUDGET_MESSAGE = "Today's free tries are used up. Watch the demo instead.";

export const QUOTA_MESSAGE = `You have used your ${TRY_MAX_PER_IP} free tries for the next 24 hours. Watch the demo instead.`;

/**
 * Read-only quota check for the upload-token route: blocks the upload when
 * the IP is out of tries WITHOUT consuming quota (only /try/start counts).
 */
export async function assertTryQuota(ip: string): Promise<void> {
  const r = await redis();
  const v = await r.get<number | string>(`daari:try:ip:${ip}`);
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) || 0 : 0;
  if (n >= TRY_MAX_PER_IP) {
    throw new TryBlockedError(QUOTA_MESSAGE);
  }
}

export async function assertTryBudget(): Promise<void> {
  if ((await trySpendToday()) >= TRY_DAILY_BUDGET_USD) {
    throw new TryBlockedError(BUDGET_MESSAGE);
  }
}

export async function addTrySpend(usd: number): Promise<number> {
  const r = await redis();
  return r.incrbyfloat(tryBudgetKey(), usd);
}

export interface TryState {
  ip: string;
  step: number;
  created: number;
  blobUrl: string;
  fileName: string;
  durationSec: number;
  cost: number;
  verdictJson: string;
}

function tryKey(tryId: string): string {
  return `daari:try:${tryId}`;
}

/** Create a try after quota checks; returns the new tryId. */
export async function tryCreate(args: {
  ip: string;
  blobUrl: string;
  fileName: string;
  durationSec: number;
}): Promise<string> {
  assertTryEnabled();
  await assertTryBudget();
  const r = await redis();
  const quotaKey = `daari:try:ip:${args.ip}`;
  const n = await r.incr(quotaKey);
  if (n === 1) await r.expire(quotaKey, IP_WINDOW_SECONDS);
  if (n > TRY_MAX_PER_IP) {
    throw new TryBlockedError(QUOTA_MESSAGE);
  }
  const tryId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  await r.hset(tryKey(tryId), {
    ip: args.ip,
    step: 0,
    created: Date.now(),
    blobUrl: args.blobUrl,
    fileName: args.fileName,
    durationSec: args.durationSec,
    cost: 0,
    verdictJson: '',
  });
  await r.expire(tryKey(tryId), TRY_TTL_SECONDS);
  return tryId;
}

/** Load try state, enforcing IP ownership. */
export async function tryLoad(tryId: string, ip: string): Promise<TryState> {
  assertTryEnabled();
  const r = await redis();
  const h = await r.hgetall<Record<string, unknown>>(tryKey(tryId));
  if (!h || typeof h.ip !== 'string') {
    throw new TryClientError('This try expired or does not exist. Start a new one.');
  }
  if (h.ip !== ip) {
    throw new TryClientError('This try belongs to a different session.');
  }
  const asString = (v: unknown): string =>
    v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return {
    ip: h.ip,
    step: Number(h.step),
    created: Number(h.created),
    blobUrl: asString(h.blobUrl),
    fileName: asString(h.fileName),
    durationSec: Number(h.durationSec),
    cost: Number(h.cost),
    verdictJson: asString(h.verdictJson),
  };
}

/** Advance the state machine exactly one step (no repeats, no skips). */
export async function tryAdvance(tryId: string, from: number, patch: Record<string, string | number> = {}): Promise<void> {
  const r = await redis();
  const cur = await r.hget<number>(tryKey(tryId), 'step');
  if (cur === null || Number(cur) !== from) {
    throw new TryClientError('Steps ran out of order. Start a new try.');
  }
  await r.hset(tryKey(tryId), { step: from + 1, ...patch });
  await r.expire(tryKey(tryId), TRY_TTL_SECONDS);
}

/** Bump a try's running cost + the daily budget (no ledger entry). */
export async function tryAddCost(tryId: string, usd: number): Promise<number> {
  const r = await redis();
  const cost = await r.hincrbyfloat(tryKey(tryId), 'cost', usd);
  await addTrySpend(usd);
  return typeof cost === 'number' ? cost : parseFloat(String(cost)) || 0;
}

/** Record one paid /try step: try ledger entry + running cost + daily budget. */
export async function tryLedger(args: {
  tryId: string;
  kind: 'try-detect' | 'try-verdict' | 'try-assess';
  model: string;
  detail: string;
  estUSD: number;
}): Promise<number> {
  await ledgerAppend({
    ts: new Date().toISOString(),
    model: args.model,
    kind: args.kind,
    tryId: args.tryId,
    detail: args.detail,
    estUSD: args.estUSD,
  });
  return tryAddCost(args.tryId, args.estUSD);
}

/**
 * Read one extra field (stored step results for idempotent retries).
 * Upstash auto-parses stored JSON, so re-stringify objects for the callers'
 * JSON.parse.
 */
export async function tryGet(tryId: string, field: string): Promise<string> {
  const r = await redis();
  const v = await r.hget<unknown>(tryKey(tryId), field);
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Mark a try finished (from any unfinished step); returns its last state. */
export async function tryFinishState(tryId: string, ip: string): Promise<TryState> {
  const st = await tryLoad(tryId, ip);
  if (st.step >= 4) throw new TryClientError('This try is already finished.');
  const r = await redis();
  await r.hset(tryKey(tryId), { step: 4 });
  await r.expire(tryKey(tryId), TRY_TTL_SECONDS);
  return st;
}
