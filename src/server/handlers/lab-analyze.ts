import { z } from 'zod';

import {
  ClipName,
  ConceptName,
  errMessage,
  jsonError,
  loadPreppedClip,
  preppedHash,
  preppedVideoPath,
} from '@/lib/clips';

const Body = z.object({
  clip: ClipName,
  concepts: z.array(ConceptName).min(1).max(20).optional(),
});

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

  const clip = parsed.data.clip;

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
    // Dynamic imports: these modules throw at load when MODEL_API_KEY is
    // unset, and we want that as a JSON error, not a crashed route.
    const { uploadClip } = await import('@/lib/files');
    const { CONCEPTS, estimateCostUSD, getSpend, readSamCache, runSam } = await import('@/lib/sam');

    const concepts = Array.from(new Set(parsed.data.concepts ?? CONCEPTS));

    // Cached upload: the same clip bytes are never uploaded twice. Skip the
    // upload entirely when everything is cached (production has no video
    // files); runSam returns early on cache hits without touching fileId.
    const needUpload = concepts.some((c) => readSamCache(hash, c) === null);
    const fileId = needUpload ? await uploadClip(preppedVideoPath(clip)) : 'cached';

    const clipMeta = {
      frameCount: clipInfo.frameCount,
      fps: clipInfo.fps,
      width: clipInfo.width,
      height: clipInfo.height,
    };

    // One SAM request per concept, one after another. Cached concepts return
    // instantly with no API call.
    const summaries = [];
    let estCostThisRun = 0;
    for (const concept of concepts) {
      const wasCached = readSamCache(hash, concept) !== null;
      const result = await runSam({ fileId, hash, concept, meta: clipMeta });
      if (!wasCached) estCostThisRun += estimateCostUSD(clipInfo.frameCount);
      summaries.push({ ...result.summary, cached: wasCached });
    }

    return Response.json({ summaries, estCostThisRun, spentTotal: await getSpend() });
  } catch (err) {
    return jsonError(errMessage(err), 500);
  }
}
