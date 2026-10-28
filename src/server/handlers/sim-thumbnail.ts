import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { ClipName, blurredVideoPath, errMessage, hashFile, jsonError, loadPreppedClip } from '@/lib/clips';

const Query = z.object({ clip: ClipName, second: z.coerce.number().min(0) });

const THUMBS_DIR = path.join(process.cwd(), 'data', 'cache', 'thumbs');

/** Evidence thumbnail: one ffmpeg frame grab, extracted once and cached. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    clip: url.searchParams.get('clip'),
    second: url.searchParams.get('second'),
  });
  if (!parsed.success) {
    return jsonError(`Invalid query: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 400);
  }
  const { clip, second } = parsed.data;

  const clipInfo = loadPreppedClip(clip);
  if (!clipInfo) {
    return jsonError(
      `Unknown clip "${clip}". Prep it first: npx tsx scripts/prep-clip.ts ${clip}`,
      404,
    );
  }

  // Thumbnails come from the BLURRED clip, keyed by its hash, so no cached
  // thumbnail can ever show an unblurred face or plate.
  let hash: string;
  try {
    hash = hashFile(blurredVideoPath(clip));
  } catch (err) {
    return jsonError(
      `No blurred clip for "${clip}" (run scripts/blur-run.ts then scripts/blur-clips.ts): ${errMessage(err)}`,
      500,
    );
  }

  const duration = clipInfo.frameCount / clipInfo.fps;
  const t = Math.min(second, Math.max(0, duration - 0.1));
  const thumbPath = path.join(THUMBS_DIR, hash, `s${second}.jpg`);
  if (!fs.existsSync(thumbPath)) {
    fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
    try {
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          t.toFixed(3),
          '-i',
          blurredVideoPath(clip),
          '-frames:v',
          '1',
          '-q:v',
          '4',
          '-vf',
          'scale=320:-1',
          thumbPath,
        ],
        { stdio: 'ignore' },
      );
    } catch {
      return jsonError(`Could not extract a thumbnail at second ${second}.`, 500);
    }
  }

  try {
    const data = new Uint8Array(fs.readFileSync(thumbPath));
    return new Response(data, {
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    return jsonError(`Could not read thumbnail: ${errMessage(err)}`, 500);
  }
}
