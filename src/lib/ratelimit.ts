import { isProduction } from './snapshot';

/**
 * Production rate limit for live Routes/Places calls: 20 per IP per hour,
 * counted in Redis. Locally a no-op (no Redis, no shared quota).
 */

const LIMIT_PER_HOUR = 20;

async function redis() {
  const { Redis } = await import('@upstash/redis');
  return Redis.fromEnv();
}

export async function checkRateLimit(
  what: 'routes' | 'places',
  clientIp: string,
): Promise<void> {
  if (!isProduction()) return;
  const hour = new Date().toISOString().slice(0, 13).replace(/[^0-9]/g, '');
  const key = `daari:rl:${what}:${clientIp}:${hour}`;
  const r = await redis();
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, 3600);
  if (n > LIMIT_PER_HOUR) {
    throw new Error(`Rate limit exceeded for ${what} (20 per hour). Try again later.`);
  }
}

/** Best-effort client IP behind Vercel's proxy. */
export function clientIpFrom(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  const first = fwd ? fwd.split(',')[0].trim() : '';
  if (first) return first.replace(/[^0-9a-zA-Z.:-]/g, '').slice(0, 64) || 'unknown';
  return 'unknown';
}
