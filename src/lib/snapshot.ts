import fs from 'node:fs';
import path from 'node:path';

/**
 * Committed demo snapshot (Step 7). data/snapshot/ holds copies of the cached
 * API results a fresh deploy needs for /lab and the /sim demo (SAM boxes,
 * stills counts, verdicts, agent assessments, route and places responses),
 * so replays cost $0 without a warmed data/cache/.
 *
 * Key-free: snapshot reads never need MODEL_API_KEY.
 */

export function snapshotDir(): string {
  return path.join(process.cwd(), 'data', 'snapshot');
}

/** True on Vercel (production): read-only, snapshot-only, Redis ledger. */
export function isProduction(): boolean {
  return process.env.VERCEL === '1';
}

/** Local filesystem writes are forbidden on Vercel. */
export function canWriteFiles(): boolean {
  return !isProduction();
}

/**
 * Live API calls happen only with LIVE_CALLS=true. LIVE_CALLS_ENABLED=false
 * is a kill switch that blocks everything, instantly.
 */
export function liveCallsAllowed(): boolean {
  if (process.env.LIVE_CALLS_ENABLED === 'false') return false;
  return process.env.LIVE_CALLS === 'true';
}

/** Write a cache file locally; silently skip on Vercel (read-only). */
export function writeCacheFile(filePath: string, data: string): void {
  if (!canWriteFiles()) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

/** Throw a clear "not in snapshot" error unless live calls are allowed. */
export function assertLiveCalls(what: string): void {
  if (liveCallsAllowed()) return;
  throw new Error(
    `${what} is not in the local snapshot (checked data/cache/ then data/snapshot/). ` +
      'Set LIVE_CALLS=true to allow live API calls.',
  );
}

/** Read one JSON file from the snapshot. Null on miss or corrupt entry. */
export function readSnapshotJson<T>(relPath: string): T | null {
  try {
    const raw = fs.readFileSync(path.join(snapshotDir(), relPath), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface SnapshotClipMeta {
  name: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
}

let clipsCache: SnapshotClipMeta[] | null = null;

/** Clip metadata + content hashes (production has no video files). */
export function snapshotClipList(): SnapshotClipMeta[] {
  if (!clipsCache) {
    const parsed = readSnapshotJson<SnapshotClipMeta[]>('clips.json');
    clipsCache = Array.isArray(parsed) ? parsed : [];
  }
  return clipsCache;
}

export function snapshotClipMeta(clip: string): SnapshotClipMeta | null {
  return snapshotClipList().find((c) => c.name === clip) ?? null;
}
