import { z } from 'zod';

import {
  ClipName,
  ConceptName,
  errMessage,
  jsonError,
  loadPreppedClip,
  preppedVideoPath,
  hashFile,
} from '@/lib/clips';
import { readSamCache } from '@/lib/sam-cache';

const Query = z.object({ clip: ClipName, concept: ConceptName });

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

  const clipInfo = loadPreppedClip(clip);
  if (!clipInfo) {
    return jsonError(`Unknown clip "${clip}". Prep it first: npx tsx scripts/prep-clip.ts ${clip}`, 404);
  }

  let hash: string;
  try {
    hash = hashFile(preppedVideoPath(clip));
  } catch (err) {
    return jsonError(`Could not read clip file: ${errMessage(err)}`, 500);
  }

  const cached = readSamCache(hash, concept);
  if (!cached) {
    return jsonError(
      `No cached result for concept "${concept}" on clip "${clip}". Run Analyze first.`,
      404,
    );
  }
  return Response.json(cached);
}
