import crypto from 'node:crypto';
import { z } from 'zod';

import { Redis } from '@upstash/redis';

import { assessIncident, timeOfDayFromVerdict, type StoredAssessment } from '@/lib/agent';
import type { AgentReportInput } from '@/lib/agent-guard';
import {
  BOARD_ATTACH_METERS,
  BOARD_CLEAR_VOTES,
  BOARD_MAX_PER_IP_DAY,
  BOARD_MAX_STILLS,
  BOARD_STILL_MAX_BYTES,
  BOARD_TTL_DEFAULT_SEC,
  BOARD_TTL_MAX_SEC,
  BOARD_TTL_MIN_SEC,
  boardPostCountKey,
  findActiveNear,
  inCorridor,
  listBoard,
  saveBoardIncident,
  snapToRoad,
  type BoardIncident,
  type BoardStill,
  type BoardVerdict,
} from '@/lib/board';
import type { VerdictCheck } from '@/lib/checks';
import { jsonError } from '@/lib/clips';
import { clientIpFrom } from '@/lib/ratelimit';
import {
  addTrySpend,
  assertTryBudget,
  assertTryEnabled,
  etDayKey,
  isOwnerRequest,
  TryBlockedError,
  TryClientError,
  tryGet,
  tryLoad,
  tryPatch,
  tryPublicError,
} from '@/lib/try-limits';
import type { Verdict } from '@/lib/verdict';

import { trySamCounts, type TryDetectData } from './try-shared';

const Still = z.object({
  seconds: z.number().min(0).max(30),
  jpeg: z.string().min(100).max(200_000),
});

const Body = z.object({
  tryId: z.string().min(1).max(64),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  stills: z.array(Still).max(2).optional().default([]),
  ttlSec: z.number().int().min(BOARD_TTL_MIN_SEC).max(BOARD_TTL_MAX_SEC).optional(),
});

export const BOARD_QUOTA_MESSAGE =
  `You have posted ${BOARD_MAX_PER_IP_DAY} community reports today. Try again tomorrow.`;

/** Shared board: active community incidents. Nothing here identifies a poster. */
export async function GET(): Promise<Response> {
  const incidents = await listBoard();
  return Response.json(
    { incidents },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function slimVerdict(v: Verdict): BoardVerdict {
  return {
    type: v.type,
    stage: v.stage,
    summary: v.summary,
    responders: v.responders,
    lanesBlocked: v.lanesBlocked,
  };
}

function checkedStills(stills: { seconds: number; jpeg: string }[]): BoardStill[] {
  return stills.map((s) => {
    const m = s.jpeg.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new TryClientError('Stills must be JPEG data URLs.');
    if (Math.floor(m[1].length * 0.75) > BOARD_STILL_MAX_BYTES) {
      throw new TryClientError('A still is over the 80 KB limit.');
    }
    return { seconds: s.seconds, jpeg: s.jpeg };
  });
}

function reportFromTry(args: {
  reportId: string;
  tryId: string;
  durationSec: number;
  minutesSinceFirstReport: number;
  verdict: Verdict;
  checks: VerdictCheck[];
  detectRaw: string;
}): AgentReportInput {
  let samCounts: Record<string, string> = {};
  try {
    samCounts = args.detectRaw ? trySamCounts(JSON.parse(args.detectRaw) as TryDetectData) : {};
  } catch {
    samCounts = {};
  }
  return {
    reportId: args.reportId,
    minutesSinceFirstReport: args.minutesSinceFirstReport,
    clip: `try:${args.tryId}`,
    clipDurationSeconds: args.durationSec,
    reporterDirection: 'same',
    verdict: args.verdict,
    samCounts,
    checks: args.checks,
  };
}

/**
 * Post a /try run to the live map. The post kind (incident vs all-clear)
 * is re-read from server state, never trusted from the client. Posting
 * itself makes no AI calls; only a follow-up attach runs the Level 3
 * agent, ledgered under the try quota and daily budget.
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
  const { tryId, lat, lng, stills, ttlSec } = parsed.data;

  try {
    assertTryEnabled();
    const ip = clientIpFrom(req);
    const owner = isOwnerRequest(req);
    const st = await tryLoad(tryId, ip, { skipIpCheck: owner });

    // Kind from server state: a finished incident run, else a Level 1
    // all-clear. Anything else cannot be posted.
    const verdictRaw = await tryGet(tryId, 'verdictJson');
    const assessRaw = await tryGet(tryId, 'assessJson');
    const qlRaw = await tryGet(tryId, 'quicklookJson');
    let kind: 'incident' | 'clear';
    let verdict: Verdict | null = null;
    let checks: VerdictCheck[] = [];
    let stored: StoredAssessment | null = null;
    if (verdictRaw) {
      ({ verdict, checks } = JSON.parse(verdictRaw) as { verdict: Verdict; checks: VerdictCheck[] });
      if (!verdict.incident) {
        throw new TryClientError('Only confirmed incidents can be posted to the live map.');
      }
      if (!assessRaw) throw new TryClientError('Finish the analysis before posting.');
      stored = JSON.parse(assessRaw) as StoredAssessment;
      kind = 'incident';
    } else if (qlRaw) {
      const ql = JSON.parse(qlRaw) as { flag?: string };
      if (ql.flag !== 'clear') throw new TryClientError('Finish the analysis before posting.');
      kind = 'clear';
    } else {
      throw new TryClientError('Analyze a clip before posting.');
    }

    if (!inCorridor(lat, lng)) {
      throw new TryClientError('That spot is outside the CT–NYC corridor.');
    }
    const snap = snapToRoad(lat, lng);
    if (!snap) {
      throw new TryClientError('No major road within 300 m — pick a spot on a road.');
    }
    if (await tryGet(tryId, 'boardPosted')) {
      throw new TryClientError('This run is already posted.');
    }
    await assertTryBudget();
    if (!owner) {
      const r = Redis.fromEnv();
      const key = boardPostCountKey(ip, etDayKey());
      const n = await r.incr(key);
      if (n === 1) await r.expire(key, 2 * 86400);
      if (n > BOARD_MAX_PER_IP_DAY) throw new TryBlockedError(BOARD_QUOTA_MESSAGE);
    }

    const now = Date.now();
    const expiresAt = now + (ttlSec ?? BOARD_TTL_DEFAULT_SEC) * 1000;
    const near = await findActiveNear(snap.lat, snap.lng, BOARD_ATTACH_METERS);

    if (kind === 'clear') {
      await tryPatch(tryId, { boardPosted: near ? near.id : 'clear' });
      if (!near) return Response.json({ posted: true, attached: false });
      near.clearCount += 1;
      near.updatedAt = now;
      let cleared = false;
      if (near.clearCount >= BOARD_CLEAR_VOTES) {
        near.stage = 'cleared';
        near.active = false;
        cleared = true;
      }
      await saveBoardIncident(near);
      return Response.json({ posted: true, attached: true, id: near.id, clearCount: near.clearCount, cleared });
    }

    // Incident post: attach as a follow-up, or open a new board incident.
    const checked = checkedStills(stills);
    const detectRaw = await tryGet(tryId, 'detectJson');
    if (near) {
      const report = reportFromTry({
        reportId: `r${near.reports.length + 1}`,
        tryId,
        durationSec: st.durationSec,
        minutesSinceFirstReport: (now - near.createdAt) / 60000,
        verdict: verdict as Verdict,
        checks,
        detectRaw,
      });
      const { result, cached } = await assessIncident(
        {
          reports: [...near.reports, report],
          previousAssessment: near.assessment.assessment,
          minutesSinceLastReport: Math.max(0, (now - near.updatedAt) / 60000),
          timeOfDay: timeOfDayFromVerdict(verdict as Verdict),
        },
        { ledgerKind: 'try-assess', liveAuthorized: true },
      );
      if (!cached) await addTrySpend(result.estUSD);
      near.reports.push(report);
      near.assessment = result;
      near.verdict = slimVerdict(verdict as Verdict);
      near.stage = result.assessment.stage;
      near.active = near.stage !== 'cleared';
      near.stills = [...near.stills, ...checked].slice(-BOARD_MAX_STILLS);
      near.reportCount += 1;
      near.updatedAt = now;
      await saveBoardIncident(near);
      await tryPatch(tryId, { boardPosted: near.id });
      return Response.json({
        posted: true,
        attached: true,
        id: near.id,
        reportCount: near.reportCount,
        stage: near.stage,
      });
    }

    const id = crypto.randomUUID();
    const first = reportFromTry({
      reportId: 'r1',
      tryId,
      durationSec: st.durationSec,
      minutesSinceFirstReport: 0,
      verdict: verdict as Verdict,
      checks,
      detectRaw,
    });
    const inc: BoardIncident = {
      id,
      lat: snap.lat,
      lng: snap.lng,
      road: snap.road,
      bearingDeg: snap.bearingDeg,
      verdict: slimVerdict(verdict as Verdict),
      assessment: stored as StoredAssessment,
      reports: [first],
      stills: checked.slice(-BOARD_MAX_STILLS),
      reportCount: 1,
      clearCount: 0,
      stage: (stored as StoredAssessment).assessment.stage,
      active: (stored as StoredAssessment).assessment.stage !== 'cleared',
      createdAt: now,
      updatedAt: now,
      expiresAt,
      source: 'community',
    };
    await saveBoardIncident(inc);
    await tryPatch(tryId, { boardPosted: id });
    return Response.json({ posted: true, attached: false, id, road: snap.road });
  } catch (err) {
    const pub = tryPublicError(err);
    return jsonError(pub.message, pub.status);
  }
}
