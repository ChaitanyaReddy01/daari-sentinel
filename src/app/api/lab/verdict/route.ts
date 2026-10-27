import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import {
  ClipName,
  errMessage,
  hashFile,
  jsonError,
  loadPreppedClip,
  preppedVideoPath,
} from '@/lib/clips';
import { MUSE_SPARK_MODEL } from '@/lib/config';
import { readSamCache } from '@/lib/sam-cache';
import type { SamCachedResult } from '@/lib/sam';
import { buildChecks } from '@/lib/checks';
import { estimateVerdictCost, readVerdictCache } from '@/lib/verdict-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({ clip: ClipName });
const Body = z.object({ clip: ClipName });

const CHECK_CONCEPTS = [
  'police car',
  'ambulance',
  'fire truck',
  'tow truck',
  'car',
  'truck',
  'person',
];

/** True when any SAM result is cached for this clip hash. */
function hasSamResults(hash: string): boolean {
  try {
    const dir = path.join(process.cwd(), 'data', 'cache', 'sam', hash);
    return fs.readdirSync(dir).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/** Key-free probe: is this clip's verdict cached, and what would it cost? */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = Query.safeParse({ clip: url.searchParams.get('clip') });
  if (!parsed.success) {
    return jsonError(`Invalid query: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 400);
  }
  const { clip } = parsed.data;

  const clipInfo = loadPreppedClip(clip);
  if (!clipInfo) {
    return jsonError(
      `Unknown clip "${clip}". Prep it first: npx tsx scripts/prep-clip.ts ${clip}`,
      404,
    );
  }

  let hash: string;
  try {
    hash = hashFile(preppedVideoPath(clip));
  } catch (err) {
    return jsonError(`Could not read clip file: ${errMessage(err)}`, 500);
  }

  const cached = readVerdictCache(hash) !== null;
  return Response.json({
    cached,
    estimateUSD: cached ? 0 : estimateVerdictCost(MUSE_SPARK_MODEL, clipInfo.frameCount),
    hasSamResults: hasSamResults(hash),
  });
}

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

  const { clip } = parsed.data;

  const clipInfo = loadPreppedClip(clip);
  if (!clipInfo) {
    return jsonError(
      `Unknown clip "${clip}". Prep it first: npx tsx scripts/prep-clip.ts ${clip}`,
      404,
    );
  }

  let hash: string;
  try {
    hash = hashFile(preppedVideoPath(clip));
  } catch (err) {
    return jsonError(`Could not read clip file: ${errMessage(err)}`, 500);
  }

  try {
    // Dynamic imports: keyed modules throw at load when MODEL_API_KEY is
    // unset, and we want that as a JSON error, not a crashed route.
    const { runVerdict } = await import('@/lib/spark');
    const { getSpend } = await import('@/lib/sam');

    const { result, cached } = await runVerdict({ clip });

    const sam: Record<string, SamCachedResult | null> = {};
    for (const concept of CHECK_CONCEPTS) {
      sam[concept] = readSamCache(hash, concept);
    }
    const checks = buildChecks({ verdict: result.verdict, sam, fps: clipInfo.fps });

    return Response.json({
      verdict: result.verdict,
      checks,
      cached,
      estCostThisRun: cached ? 0 : result.estUSD,
      spentTotal: getSpend(),
    });
  } catch (err) {
    return jsonError(errMessage(err), 500);
  }
}
