/**
 * Render blurred display copies of every prepped clip.
 *
 * Usage: npx tsx scripts/blur-clips.ts [--force] [clip...]
 *
 * For each clip, decodes the 10 fps prepped clip to PNG frames with ffmpeg,
 * blurs every SAM "face" / "license plate" box (padded 20%, unioned over
 * ±1 frame so nothing flickers through) with sharp, and re-encodes to
 * H.264 + faststart in public/clips/blurred/<clip>.mp4. Models keep
 * analyzing the unblurred prepped clips; people only ever see blurred.
 *
 * Prereq: scripts/blur-run.ts (face/plate SAM caches). No API calls here.
 * Existing outputs are skipped unless --force is passed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { hashFile, listPreppedClips, preppedVideoPath } from '../src/lib/clips';
import { readSamCache } from '../src/lib/sam-cache';
import type { SamBox, SamCachedResult } from '../src/lib/sam';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BLURRED_DIR = path.join(ROOT, 'public', 'clips', 'blurred');
const WORK_ROOT =
  process.env.BLUR_WORK_DIR || path.join(ROOT, '.tmp-verify', 'blur-work');
const BLUR_CONCEPTS = ['face', 'license plate'];
/** Box padding on each side, as a fraction of the box size. */
const BOX_PAD = 0.2;

function fail(message: string): never {
  console.error(`blur-clips: ${message}`);
  process.exit(1);
}

function errMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function ffmpegBin(): string {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as unknown;
    if (typeof p === 'string' && p.length > 0 && fs.existsSync(p)) return p;
  } catch {
    // Fall through to bare ffmpeg on PATH.
  }
  return 'ffmpeg';
}

interface PaddedBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function padBox(b: SamBox, imgW: number, imgH: number): PaddedBox | null {
  const w = b.x2 - b.x1;
  const h = b.y2 - b.y1;
  if (!(w > 0 && h > 0)) return null;
  const left = Math.max(0, Math.floor(b.x1 - w * BOX_PAD));
  const top = Math.max(0, Math.floor(b.y1 - h * BOX_PAD));
  const right = Math.min(imgW, Math.ceil(b.x2 + w * BOX_PAD));
  const bottom = Math.min(imgH, Math.ceil(b.y2 + h * BOX_PAD));
  if (right - left < 2 || bottom - top < 2) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Strong blur, scaled to the box so small plates still wash out fully. */
function sigmaFor(box: PaddedBox): number {
  return Math.min(40, Math.max(8, Math.round(Math.min(box.width, box.height) / 3)));
}

async function blurFrame(
  framePath: string,
  boxes: PaddedBox[],
  imgW: number,
  imgH: number,
): Promise<void> {
  if (boxes.length === 0) return;
  const overlays: { input: Buffer; left: number; top: number }[] = [];
  for (const box of boxes) {
    const buf = await sharp(framePath)
      .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
      .blur(sigmaFor(box))
      .toBuffer();
    overlays.push({ input: buf, left: box.left, top: box.top });
  }
  const tmpPath = `${framePath}.blur.png`;
  await sharp({ create: { width: imgW, height: imgH, channels: 3, background: '#000' } })
    .composite([{ input: framePath }, ...overlays])
    .png()
    .toFile(tmpPath);
  fs.renameSync(tmpPath, framePath);
}

async function blurClip(
  clip: string,
  frameCount: number,
  fps: number,
  width: number,
  height: number,
  ffmpeg: string,
): Promise<{ frames: number; blurred: number; boxes: number }> {
  const hash = hashFile(preppedVideoPath(clip));
  const results: SamCachedResult[] = [];
  for (const concept of BLUR_CONCEPTS) {
    const r = readSamCache(hash, concept);
    if (!r) fail(`no cached "${concept}" for "${clip}" — run scripts/blur-run.ts first.`);
    results.push(r);
  }
  const byFrame = new Map<number, SamBox[]>();
  for (const r of results) {
    for (const b of r.boxes) {
      const list = byFrame.get(b.frame) ?? [];
      list.push(b);
      byFrame.set(b.frame, list);
    }
  }

  const workDir = path.join(WORK_ROOT, clip);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    execFileSync(
      ffmpeg,
      ['-y', '-v', 'error', '-i', preppedVideoPath(clip), path.join(workDir, 'f%04d.png')],
      { stdio: 'inherit' },
    );
  } catch {
    throw new Error(`ffmpeg decode failed for "${clip}".`);
  }
  const frames = fs
    .readdirSync(workDir)
    .filter((f) => f.endsWith('.png'))
    .sort();
  if (frames.length !== frameCount) {
    console.warn(
      `blur-clips: ${clip}: decoded ${frames.length} frames, meta says ${frameCount} — mapping by index.`,
    );
  }

  let blurred = 0;
  let boxTotal = 0;
  for (let i = 0; i < frames.length; i += 1) {
    // Union boxes over ±1 frame so a face missed on one frame stays covered.
    const near: SamBox[] = [];
    for (const f of [i - 1, i, i + 1]) {
      const list = byFrame.get(f);
      if (list) near.push(...list);
    }
    const padded = near
      .map((b) => padBox(b, width, height))
      .filter((b): b is PaddedBox => b !== null);
    if (padded.length === 0) continue;
    await blurFrame(path.join(workDir, frames[i]), padded, width, height);
    blurred += 1;
    boxTotal += padded.length;
  }

  fs.mkdirSync(BLURRED_DIR, { recursive: true });
  const outPath = path.join(BLURRED_DIR, `${clip}.mp4`);
  try {
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-framerate',
        String(fps),
        '-i',
        path.join(workDir, 'f%04d.png'),
        '-c:v',
        'libx264',
        '-crf',
        '20',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outPath,
      ],
      { stdio: 'inherit' },
    );
  } catch {
    throw new Error(`ffmpeg encode failed for "${clip}".`);
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  return { frames: frames.length, blurred, boxes: boxTotal };
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  const args = process.argv.slice(2).filter((a) => a !== '--force');
  const force = process.argv.includes('--force');
  const ffmpeg = ffmpegBin();

  const all = listPreppedClips();
  if (all.length === 0) fail('no prepped clips found.');
  const wanted = args.length > 0 ? new Set(args) : null;
  const clips = wanted ? all.filter((c) => wanted.has(c.name)) : all;
  if (wanted) {
    wanted.forEach((name) => {
      if (!all.some((c) => c.name === name)) fail(`unknown prepped clip "${name}".`);
    });
  }

  for (const clip of clips) {
    const outPath = path.join(BLURRED_DIR, `${clip.name}.mp4`);
    if (!force && fs.existsSync(outPath)) {
      console.log(`blur-clips: ${clip.name}: already blurred, skipping (--force to redo).`);
      continue;
    }
    try {
      const { frames, blurred, boxes } = await blurClip(
        clip.name,
        clip.frameCount,
        clip.fps,
        clip.width,
        clip.height,
        ffmpeg,
      );
      const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
      console.log(
        `blur-clips: ${clip.name}: ${blurred}/${frames} frames blurred (${boxes} boxes) → ${mb} MB.`,
      );
    } catch (err) {
      console.error(`blur-clips: ${clip.name} FAILED: ${errMessage(err)} (continuing)`);
    }
  }
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`blur-clips: fatal: ${errMessage(err)}`);
  process.exit(1);
});
