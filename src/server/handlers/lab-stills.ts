import { z } from 'zod';

import {
  ClipName,
  ConceptName,
  errMessage,
  jsonError,
  loadPreppedClip,
  preppedHash,
} from '@/lib/clips';

const Query = z.object({ clip: ClipName, concept: ConceptName });

const STILLS_CONCEPTS = ['car', 'truck', 'person'];

/**
 * Cached true count for one concept on one clip (max over the still frames).
 * Never bills: misses return { count: null }.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    clip: url.searchParams.get('clip'),
    concept: url.searchParams.get('concept'),
  });
  if (!parsed.success) {
    return jsonError(`Invalid query: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 400);
  }
  const { clip, concept } = parsed.data;
  if (!STILLS_CONCEPTS.includes(concept)) {
    return jsonError(
      `True counts exist only for ${STILLS_CONCEPTS.join(', ')}.`,
      400,
    );
  }

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
    // Dynamic import: stills.ts is keyed, but count:false never bills.
    const { readStillsCount, stillFrames } = await import('@/lib/stills');
    const frames = stillFrames(clipInfo.frameCount, clipInfo.fps);
    const counts: number[] = [];
    for (const frame of frames) {
      const hit = readStillsCount(hash, frame, concept);
      if (hit !== null) counts.push(hit);
    }
    return Response.json({ count: counts.length > 0 ? Math.max(...counts) : null });
  } catch {
    return Response.json({ count: null });
  }
}
