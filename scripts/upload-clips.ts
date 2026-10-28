/**
 * Upload display clips + evidence thumbnails to Vercel Blob.
 *
 * Usage: npx tsx scripts/upload-clips.ts
 *
 * Uploads every file in public/clips/blurred/ (video/mp4) plus one
 * per-second 320px thumbnail per clip (image/jpeg) with stable pathnames
 * (clips/blurred/<name>.mp4, clips/thumbs/<name>/s<sec>.jpg). Files already
 * present with the same size are skipped. Writes
 * data/snapshot/clip-urls.json mapping clips (and thumbs) to blob URLs.
 * Needs BLOB_READ_WRITE_TOKEN (env or .env.local).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { list, put } from '@vercel/blob';

import { listPreppedClips } from '../src/lib/clips';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BLURRED_DIR = path.join(ROOT, 'public', 'clips', 'blurred');
const THUMB_WORK = path.join(ROOT, 'data', 'cache', 'blob-thumbs');
const URLS_PATH = path.join(ROOT, 'data', 'snapshot', 'clip-urls.json');

function fail(message: string): never {
  console.error(`upload-clips: ${message}`);
  process.exit(1);
}

function errMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

function loadToken(): string {
  if (process.env.BLOB_READ_WRITE_TOKEN) return unquote(process.env.BLOB_READ_WRITE_TOKEN);
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
    const m = raw.match(/^BLOB_READ_WRITE_TOKEN=\s*(.+?)\s*$/m);
    if (m) return unquote(m[1]);
  } catch {
    // Fall through to the failure below.
  }
  fail('BLOB_READ_WRITE_TOKEN is not set (checked env and .env.local).');
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

interface ClipUrls {
  clips: Record<string, string>;
  thumbs: Record<string, Record<string, string>>;
  maxSec: Record<string, number>;
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  const token = loadToken();
  const ffmpeg = ffmpegBin();

  const clips = listPreppedClips().filter((c) =>
    fs.existsSync(path.join(BLURRED_DIR, `${c.name}.mp4`)),
  );
  if (clips.length === 0) fail('no blurred clips found in public/clips/blurred/.');

  console.log('upload-clips: listing remote blobs...');
  const remote = new Map<string, { size: number; url: string }>();
  let cursor: string | undefined;
  do {
    const page = await list({ cursor, token });
    for (const b of page.blobs) remote.set(b.pathname, { size: b.size, url: b.url });
    cursor = page.cursor;
  } while (cursor);
  console.log(`upload-clips: ${remote.size} remote blobs.`);

  const urls: ClipUrls = { clips: {}, thumbs: {}, maxSec: {} };
  let uploaded = 0;
  let skipped = 0;
  const putOne = async (
    pathname: string,
    localPath: string,
    contentType: string,
  ): Promise<string> => {
    const size = fs.statSync(localPath).size;
    const hit = remote.get(pathname);
    if (hit && hit.size === size) {
      skipped += 1;
      return hit.url;
    }
    const data = fs.readFileSync(localPath);
    const blob = await put(pathname, data, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      token,
    });
    remote.set(pathname, { size, url: blob.url });
    uploaded += 1;
    console.log(`upload-clips: put ${pathname} (${(size / 1024).toFixed(0)} KB).`);
    return blob.url;
  };

  for (const clip of clips) {
    const mp4Path = path.join(BLURRED_DIR, `${clip.name}.mp4`);
    urls.clips[clip.name] = await putOne(
      `clips/blurred/${clip.name}.mp4`,
      mp4Path,
      'video/mp4',
    );
    // Stay shy of EOF (a grab at exactly duration yields no frame).
    const maxSec = Math.max(0, Math.floor(clip.frameCount / clip.fps - 0.1));
    urls.maxSec[clip.name] = maxSec;
    urls.thumbs[clip.name] = {};
    const thumbDir = path.join(THUMB_WORK, clip.name);
    fs.mkdirSync(thumbDir, { recursive: true });
    for (let sec = 0; sec <= maxSec; sec += 1) {
      const thumbPath = path.join(thumbDir, `s${sec}.jpg`);
      if (!fs.existsSync(thumbPath)) {
        try {
          execFileSync(
            ffmpeg,
            [
              '-y',
              '-v',
              'error',
              '-ss',
              sec.toFixed(3),
              '-i',
              mp4Path,
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
          fail(`ffmpeg thumbnail failed for ${clip.name} s${sec}.`);
        }
      }
      urls.thumbs[clip.name][String(sec)] = await putOne(
        `clips/thumbs/${clip.name}/s${sec}.jpg`,
        thumbPath,
        'image/jpeg',
      );
    }
    console.log(`upload-clips: ${clip.name}: mp4 + ${maxSec + 1} thumbs.`);
  }

  fs.mkdirSync(path.dirname(URLS_PATH), { recursive: true });
  fs.writeFileSync(URLS_PATH, JSON.stringify(urls));
  console.log(
    `upload-clips: wrote ${URLS_PATH} (${clips.length} clips). uploaded=${uploaded} skipped=${skipped}.`,
  );
}

main().catch((err) => {
  console.error(`upload-clips: fatal: ${errMessage(err)}`);
  process.exit(1);
});
