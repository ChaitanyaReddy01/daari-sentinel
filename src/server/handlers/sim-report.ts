import { z } from 'zod';

import {
  ClipName,
  errMessage,
  jsonError,
  loadPreppedClip,
  preppedHash,
  preppedVideoPath,
} from '@/lib/clips';
import { MUSE_SPARK_MODEL } from '@/lib/config';
import { readSamCache } from '@/lib/sam-cache';
import { estimateVerdictCost, readVerdictCache } from '@/lib/verdict-cache';

const Query = z.object({ clip: ClipName });
const Body = z.object({ clip: ClipName });

// CONCEPTS duplicated from sam.ts (key-free): the cost probe must not need
// MODEL_API_KEY. Keep in sync with src/lib/sam.ts.
const CONCEPTS = [
  'car',
  'truck',
  'police car',
  'ambulance',
  'fire truck',
  'tow truck',
  'person',
  'traffic cone',
  'construction vehicle',
  'road barrier',
  'safety vest',
];
const PRICE_PER_1K_FRAMES = 0.2;
const MIN_BILLABLE_FRAMES = 50;

/** Key-free cost probe: what would reporting this clip bill? */
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
    hash = preppedHash(clip);
  } catch (err) {
    return jsonError(`Could not read clip file: ${errMessage(err)}`, 500);
  }

  const uncachedSam = CONCEPTS.filter((c) => !readSamCache(hash, c));
  const samEst =
    (uncachedSam.length * Math.max(MIN_BILLABLE_FRAMES, clipInfo.frameCount) * PRICE_PER_1K_FRAMES) /
    1000;
  const verdictCached = readVerdictCache(hash) !== null;
  const verdictEst = verdictCached ? 0 : estimateVerdictCost(MUSE_SPARK_MODEL, clipInfo.frameCount);
  return Response.json({
    samCached: CONCEPTS.length - uncachedSam.length,
    samTotal: CONCEPTS.length,
    verdictCached,
    estimateUSD: samEst + verdictEst,
  });
}

/** Run the full SAM + verdict pipeline for one clip (cached parts are $0). */
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
    hash = preppedHash(clip);
  } catch (err) {
    return jsonError(`Could not read clip file: ${errMessage(err)}`, 500);
  }

  try {
    // Dynamic imports: keyed modules throw at load when MODEL_API_KEY is
    // unset, and we want that as a JSON error, not a crashed route.
    const { uploadClip } = await import('@/lib/files');
    const { CONCEPTS: concepts, estimateCostUSD, getSpend, runSam } = await import('@/lib/sam');
    const { runVerdict } = await import('@/lib/spark');

    // Skip the upload when every SAM concept is already cached: runSam
    // returns early on cache hits without touching fileId, and production
    // ships no video files to upload.
    const needUpload = concepts.some((c) => readSamCache(hash, c) === null);
    const fileId = needUpload ? await uploadClip(preppedVideoPath(clip)) : 'cached';
    const meta = {
      frameCount: clipInfo.frameCount,
      fps: clipInfo.fps,
      width: clipInfo.width,
      height: clipInfo.height,
    };
    let estCostThisRun = 0;
    let allCached = true;
    for (const concept of concepts) {
      const wasCached = readSamCache(hash, concept) !== null;
      await runSam({ fileId, hash, concept, meta });
      if (!wasCached) {
        allCached = false;
        estCostThisRun += estimateCostUSD(clipInfo.frameCount);
      }
    }
    const { result, cached: verdictCached } = await runVerdict({ clip });
    if (!verdictCached) {
      allCached = false;
      estCostThisRun += result.estUSD;
    }
    return Response.json({
      verdict: result.verdict,
      cached: allCached,
      estCostThisRun,
      spentTotal: await getSpend(),
    });
  } catch (err) {
    return jsonError(errMessage(err), 500);
  }
}
