import { z } from 'zod';

import { buildChecks } from '@/lib/checks';
import { jsonError } from '@/lib/clips';
import { MUSE_SPARK_MODEL } from '@/lib/config';
import { clientIpFrom } from '@/lib/ratelimit';
import { runVerdictFromUrl } from '@/lib/spark';
import {
  assertTryBudget,
  tryAdvance,
  TryClientError,
  tryPublicError,
  tryGet,
  tryLedger,
  tryLoad,
} from '@/lib/try-limits';
import { tryHintsText, trySamRecord, type TryDetectData } from './try-shared';

const Body = z.object({
  tryId: z.string().min(1).max(64),
  // Empty when Level 2 runs in parallel: the server uses its SAM hints.
  samSummary: z.string().max(2000),
});

export const NOT_ROAD_PREFIX = 'Not road footage:';

/** Muse Spark verdict over the Blob video, with SAM stills as hints. */
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
  const { tryId, samSummary } = parsed.data;

  try {
    const ip = clientIpFrom(req);
    const st = await tryLoad(tryId, ip);
    if (st.step > 1) {
      return Response.json({
        ...(JSON.parse(await tryGet(tryId, 'verdictJson')) as object),
        cost: st.cost,
        replay: true,
      });
    }
    await assertTryBudget();

    // Level 2 runs detect + verdict in parallel: wait briefly for the SAM
    // data so the checks keep their full hints (same atomic write as step 1).
    let detectRaw = await tryGet(tryId, 'detectJson');
    if (!detectRaw) {
      const deadline = Date.now() + 30000;
      while (!detectRaw && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        detectRaw = await tryGet(tryId, 'detectJson');
      }
    }
    if (!detectRaw) throw new TryClientError('Run detect first.');
    const detect = JSON.parse(detectRaw) as TryDetectData;
    const hintsText = samSummary.trim().length > 0 ? samSummary : tryHintsText(detect);
    const outcome = await runVerdictFromUrl({ videoUrl: st.blobUrl, hintsText });
    const roadScene = !outcome.verdict.summary.startsWith(NOT_ROAD_PREFIX);
    const checks = buildChecks({
      verdict: outcome.verdict,
      sam: trySamRecord(detect),
      fps: 10,
    });
    const cost = await tryLedger({
      tryId,
      kind: 'try-verdict',
      model: MUSE_SPARK_MODEL,
      detail: 'video verdict',
      estUSD: outcome.estUSD,
    });
    const payload = { verdict: outcome.verdict, checks, roadScene };
    await tryAdvance(tryId, 1, { verdictJson: JSON.stringify(payload) });
    return Response.json({ ...payload, cost });
  } catch (err) {
    const pub = tryPublicError(err);
    return jsonError(pub.message, pub.status);
  }
}
