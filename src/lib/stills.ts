import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parseImageStream, recordsOfKind } from '@meta-sam/parser';

import { meta } from './meta';
import { uploadClip } from './files';
import { hashFile, loadPreppedClip, preppedVideoPath } from './clips';
import { slug } from './sam-cache';
import { SAM_MODEL } from './sam';

/**
 * True-count pass: SAM video tracking caps at 16 objects per frame, so for
 * car/truck/person we additionally count every match on 3 still frames per
 * clip (image mode has no cap) and keep the max per concept.
 *
 * Keyed: fresh counts bill the API. Cached reads never touch the network.
 */

export const STILLS_CONCEPTS = ['car', 'truck', 'person'];
export const STILLS_FRACTIONS = [0.25, 0.5, 0.75];
/** $2.50 per 1,000 images (pricing page, 2026-10-27). */
export const STILLS_PRICE_PER_IMAGE = 2.5 / 1000;

const STILLS_DIR = path.join(process.cwd(), 'data', 'cache', 'stills');
const COUNTS_DIR = path.join(process.cwd(), 'data', 'cache', 'sam-image');
const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');

/** Frame numbers at 25/50/75% of the clip, deduplicated. */
export function stillFrames(frameCount: number, fps: number): number[] {
  if (!Number.isFinite(frameCount) || frameCount <= 0 || !Number.isFinite(fps) || fps <= 0) {
    return [];
  }
  const frames = STILLS_FRACTIONS.map((f) =>
    Math.min(frameCount - 1, Math.max(0, Math.round(frameCount * f))),
  );
  return frames.filter((f, i) => frames.indexOf(f) === i).sort((a, b) => a - b);
}

export function stillImagePath(hash: string, frame: number): string {
  return path.join(STILLS_DIR, hash, `f${frame}.jpg`);
}

export function stillCountPath(hash: string, frame: number, concept: string): string {
  return path.join(COUNTS_DIR, hash, `f${frame}`, `${slug(concept)}.json`);
}

/** Extract one still frame with ffmpeg (accurate seek, overwrites). */
export function extractStill(videoPath: string, frame: number, fps: number, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        (frame / fps).toFixed(3),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        outPath,
      ],
      { stdio: 'ignore' },
    );
  } catch {
    throw new Error(
      `Could not extract frame ${frame} from ${videoPath} (is ffmpeg on PATH?).`,
    );
  }
}

/** Read a cached still count. Null on miss or corrupt entry. */
export function readStillsCount(hash: string, frame: number, concept: string): number | null {
  try {
    const raw = fs.readFileSync(stillCountPath(hash, frame, concept), 'utf8');
    const parsed = JSON.parse(raw) as { count?: unknown };
    return typeof parsed.count === 'number' && Number.isFinite(parsed.count) ? parsed.count : null;
  } catch {
    return null;
  }
}

export interface StillsLedgerEntry {
  ts: string;
  model: string;
  hash: string;
  kind: 'sam-image';
  concept: string;
  frame: number;
  images: number;
  estUSD: number;
}

function appendStillsLedger(entry: StillsLedgerEntry): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
}

/**
 * Count every match of one concept on one still frame (image mode has no
 * 16-object cap). Cached per clip+frame+concept; bills $0.0025 when fresh.
 */
export async function runStillsCount({
  clip,
  concept,
  frame,
}: {
  clip: string;
  concept: string;
  frame: number;
}): Promise<{ count: number; cached: boolean }> {
  const clipInfo = loadPreppedClip(clip);
  if (!clipInfo) {
    throw new Error(`Unknown clip "${clip}". Prep it first: npx tsx scripts/prep-clip.ts ${clip}`);
  }
  const hash = hashFile(preppedVideoPath(clip));

  const hit = readStillsCount(hash, frame, concept);
  if (hit !== null) return { count: hit, cached: true };

  const imagePath = stillImagePath(hash, frame);
  if (!fs.existsSync(imagePath)) {
    extractStill(preppedVideoPath(clip), frame, clipInfo.fps, imagePath);
  }
  const fileId = await uploadClip(imagePath);

  const message = {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: concept },
      { type: 'input_image', file_id: fileId },
    ],
  };

  const events = await meta.responses.create({
    model: SAM_MODEL,
    // The message shape mirrors runSam's video call with input_image in place
    // of the video part; the cast stays at this boundary.
    input: [message] as unknown as Parameters<typeof meta.responses.create>[0]['input'],
    stream: true,
    metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
  });

  const result = await parseImageStream(events).finalResult;
  if (result.outcome.status !== 'completed') {
    console.warn(`[stills] ${clip} f${frame} ${concept}: outcome=${JSON.stringify(result.outcome)}`);
  }
  const ids = new Set(recordsOfKind(result.records, 'box').map((b) => b.objectId));
  const count = ids.size;

  const outPath = stillCountPath(hash, frame, concept);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ count }));

  appendStillsLedger({
    ts: new Date().toISOString(),
    model: SAM_MODEL,
    hash,
    kind: 'sam-image',
    concept,
    frame,
    images: 1,
    estUSD: STILLS_PRICE_PER_IMAGE,
  });

  return { count, cached: false };
}

/**
 * Max still count per concept over the clip's still frames. Runs fresh counts
 * for missing frames; pass count=false to read cache only (nulls for misses).
 */
export async function trueCounts(
  clip: string,
  { count }: { count: boolean },
): Promise<Record<string, number | null>> {
  const clipInfo = loadPreppedClip(clip);
  if (!clipInfo) throw new Error(`Unknown clip "${clip}".`);
  const hash = hashFile(preppedVideoPath(clip));
  const frames = stillFrames(clipInfo.frameCount, clipInfo.fps);
  const out: Record<string, number | null> = {};
  for (const concept of STILLS_CONCEPTS) {
    const counts: number[] = [];
    for (const frame of frames) {
      if (count) {
        const { count: n } = await runStillsCount({ clip, concept, frame });
        counts.push(n);
      } else {
        const hit = readStillsCount(hash, frame, concept);
        if (hit !== null) counts.push(hit);
      }
    }
    out[concept] = counts.length > 0 ? Math.max(...counts) : null;
  }
  return out;
}
