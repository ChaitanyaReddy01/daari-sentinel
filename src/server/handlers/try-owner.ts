import { z } from 'zod';

import { jsonError } from '@/lib/clips';
import { OWNER_COOKIE, ownerPassMatches, tryPublicError } from '@/lib/try-limits';

const Body = z.object({ pass: z.string().min(1).max(256) });

/** 30 days, in seconds. */
const OWNER_MAX_AGE = 30 * 24 * 3600;

/**
 * Owner pass exchange: POST { pass } sets the httpOnly owner cookie.
 * The pass travels in the POST body only, and is never logged.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return jsonError('Invalid request.', 400);
  }
  try {
    if (!process.env.OWNER_PASS) {
      return jsonError('Owner pass is not configured.', 403);
    }
    if (!ownerPassMatches(parsed.data.pass)) {
      return jsonError('Wrong owner pass.', 403);
    }
    const secure = process.env.VERCEL ? '; Secure' : '';
    const res = Response.json({ ok: true });
    res.headers.set(
      'Set-Cookie',
      `${OWNER_COOKIE}=${encodeURIComponent(parsed.data.pass)}; Path=/; Max-Age=${OWNER_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
    );
    return res;
  } catch (err) {
    const pub = tryPublicError(err);
    return jsonError(pub.message, pub.status);
  }
}
