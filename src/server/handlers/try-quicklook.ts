import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { errMessage, jsonError } from '@/lib/clips';
import { runQuicklook } from '@/lib/quicklook';
import { clientIpFrom } from '@/lib/ratelimit';
import {
  assertTryBudget,
  tryAddCost,
  tryErrorStatus,
  tryLoad,
  TryClientError,
} from '@/lib/try-limits';

const Still = z.object({
  index: z.number().int().min(0).max(3),
  seconds: z.number().min(0).max(30),
  width: z.number().int().min(16).max(1280),
  height: z.number().int().min(16).max(1280),
  jpegBase64: z.string().min(100).max(3_000_000),
});

const Body = z.object({ tryId: z.string().min(1).max(64), still: Still });

function safeTryId(tryId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(tryId)) throw new Error('Bad tryId.');
  return tryId;
}

/**
 * Level 1 quick look on one still. A pre-step at step 0: it never advances
 * the state machine, so "run full analysis anyway" continues with detect on
 * the same tryId (same quota and budget).
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
    return jsonError(`Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 400);
  }
  const { tryId, still } = parsed.data;

  try {
    const ip = clientIpFrom(req);
    const st = await tryLoad(tryId, ip);
    if (st.step !== 0) {
      throw new TryClientError('Quick look runs before detection.');
    }
    await assertTryBudget();

    const tmp = path.join(os.tmpdir(), `try-${safeTryId(tryId)}-q${still.index}.jpg`);
    const started = Date.now();
    try {
      fs.writeFileSync(tmp, Buffer.from(still.jpegBase64, 'base64'));
      const { result, cached } = await runQuicklook({ imagePath: tmp }, { liveAuthorized: true });
      const cost = await tryAddCost(tryId, cached ? 0 : result.estUSD);
      return Response.json({
        flag: result.quicklook.flag,
        reasons: result.quicklook.reasons,
        confidence: result.quicklook.confidence,
        cost,
        ms: Date.now() - started,
        cached,
      });
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best effort.
      }
    }
  } catch (err) {
    return jsonError(errMessage(err), tryErrorStatus(err));
  }
}
