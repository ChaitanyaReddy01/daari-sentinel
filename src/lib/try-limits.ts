import crypto from 'node:crypto';

import { ledgerAppend } from './ledger';

/**
 * Cost and abuse guards for /try (try-your-own-clip). All state lives in
 * Upstash Redis; the flow refuses to run without it.
 *
 * - TRY_IT_ENABLED=true kill switch (default off).
 * - Per IP: max TRY_QUOTA_PER_IP tries per 24 h (default 3, fixed window
 *   from first try). Requests with the owner cookie skip the quota but
 *   still count toward the daily budget.
 * - Global: $2.00/day of real /try cost, reset at midnight ET.
 * - tryId state machine: created(0) → detected(1) → verdict(2) → assessed(3)
 *   → finished(4). Each step checks IP ownership, exact order, no repeats.
 *   Quick look is a pre-step at 0 that never advances the machine; detect +
 *   verdict (Level 2) run in parallel, verdict waiting briefly for SAM data.
 */

export const TRY_DAILY_BUDGET_USD = 2;
export const TRY_MAX_PER_IP = Math.max(
  1,
  parseInt(process.env.TRY_QUOTA_PER_IP ?? '3', 10) || 3,
);
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

/** User-facing message for unexpected /try failures (never paths/internals). */
export const TRY_GENERIC_ERROR = 'Something went wrong analyzing this clip. Please retry.';

/**
 * Split a /try failure into a public message + status. Guard errors
 * (kill switch, quota, budget, bad tryId, out-of-order steps) are written
 * for users and pass through; everything else is logged server-side and
 * mapped to the generic message so file paths and SDK internals never leak.
 */
export function tryPublicError(err: unknown): { message: string; status: number } {
  if (err instanceof TryBlockedError || err instanceof TryClientError) {
    return { message: err.message, status: tryErrorStatus(err) };
  }
  console.error('[try] internal error:', err instanceof Error ? err.stack ?? err.message : err);
  return { message: TRY_GENERIC_ERROR, status: 500 };
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
export async function assertTryQuota(ip: string, owner = false): Promise<void> {
  if (owner) return;
  const r = await redis();
  const v = await r.get<number | string>(`daari:try:ip:${ip}`);
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) || 0 : 0;
  if (n >= TRY_MAX_PER_IP) {
    throw new TryBlockedError(QUOTA_MESSAGE);
  }
}

/** Owner cookie name (httpOnly, 30 days, set by /api/try/owner). */
export const OWNER_COOKIE = 'try_owner';

/** Timing-safe OWNER_PASS comparison. The pass itself is never logged. */
export function ownerPassMatches(candidate: string): boolean {
  const pass = process.env.OWNER_PASS;
  if (!pass || !candidate) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(pass).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when the request carries the owner cookie matching OWNER_PASS.
 * The pass itself is never logged or printed.
 */
export function isOwnerRequest(req: Request): boolean {
  const header = req.headers.get('cookie');
  if (!header) return false;
  const found = header
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${OWNER_COOKIE}=`))
    ?.slice(OWNER_COOKIE.length + 1);
  if (!found) return false;
  try {
    return ownerPassMatches(decodeURIComponent(found));
  } catch {
    return false;
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
  /** Owner requests skip the quota but still count toward the budget. */
  owner?: boolean;
}): Promise<string> {
  assertTryEnabled();
  await assertTryBudget();
  const r = await redis();
  if (!args.owner) {
    const quotaKey = `daari:try:ip:${args.ip}`;
    const n = await r.incr(quotaKey);
    if (n === 1) await r.expire(quotaKey, IP_WINDOW_SECONDS);
    if (n > TRY_MAX_PER_IP) {
      throw new TryBlockedError(QUOTA_MESSAGE);
    }
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
