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

/** Live API calls happen only with LIVE_CALLS=true. */
export function liveCallsAllowed(): boolean {
  return process.env.LIVE_CALLS === 'true';
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
