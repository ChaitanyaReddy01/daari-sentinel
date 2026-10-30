import { z } from 'zod';

import { assessIncident, timeOfDayFromVerdict } from '@/lib/agent';
import { jsonError } from '@/lib/clips';
import { clientIpFrom } from '@/lib/ratelimit';
import {
  assertTryBudget,
  tryAddCost,
  tryAdvance,
  TryClientError,
  tryPublicError,
  tryGet,
  tryLoad,
} from '@/lib/try-limits';
import { trySamCounts, type TryDetectData } from './try-shared';
import { NOT_ROAD_PREFIX } from './try-verdict';
import type { Verdict } from '@/lib/verdict';
import type { VerdictCheck } from '@/lib/checks';

const Body = z.object({ tryId: z.string().min(1).max(64) });

/** Muse Wonder single-report assessment via the existing agent + guard. */
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
  const { tryId } = parsed.data;

  try {
    const ip = clientIpFrom(req);
    const st = await tryLoad(tryId, ip);
    if (st.step > 2) {
      return Response.json({
        stored: JSON.parse(await tryGet(tryId, 'assessJson')) as object,
        cost: st.cost,
        replay: true,
      });
    }
    await assertTryBudget();

    const verdictRaw = await tryGet(tryId, 'verdictJson');
    if (!verdictRaw) throw new TryClientError('Run verdict first.');
    const { verdict, checks } = JSON.parse(verdictRaw) as {
      verdict: Verdict;
      checks: VerdictCheck[];
    };
    if (verdict.summary.startsWith(NOT_ROAD_PREFIX)) {
      throw new Error("This doesn't look like road footage.");
    }
    const detect = JSON.parse(await tryGet(tryId, 'detectJson')) as TryDetectData;
    const { result } = await assessIncident(
      {
        reports: [
          {
            reportId: 'try-r1',
            minutesSinceFirstReport: 0,
            clip: `try:${tryId}`,
            clipDurationSeconds: st.durationSec,
            reporterDirection: 'same',
            verdict,
            samCounts: trySamCounts(detect),
            checks,
          },
        ],
        previousAssessment: null,
        minutesSinceLastReport: 0,
        timeOfDay: timeOfDayFromVerdict(verdict),
      },
      { ledgerKind: 'try-assess', liveAuthorized: true },
    );
    const cost = await tryAddCost(tryId, result.estUSD);
    await tryAdvance(tryId, 2, { assessJson: JSON.stringify(result) });
    return Response.json({ stored: result, cost });
  } catch (err) {
    const pub = tryPublicError(err);
    return jsonError(pub.message, pub.status);
  }
}
