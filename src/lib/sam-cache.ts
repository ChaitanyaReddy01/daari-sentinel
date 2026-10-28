import fs from 'node:fs';
import path from 'node:path';

import type { SamCachedResult } from './sam';
import { readSnapshotJson } from './snapshot';

/**
 * Key-free SAM result cache. Reading cached boxes never needs MODEL_API_KEY,
 * so repeat views and re-analyzes are served without any API access.
 */

export function slug(concept: string): string {
  const s = concept
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'concept';
}

export function samCachePath(hash: string, concept: string): string {
  return path.join(process.cwd(), 'data', 'cache', 'sam', hash, `${slug(concept)}.json`);
}

/**
 * Read a cached SAM result: data/cache/ first, then the committed snapshot.
 * Returns null on a miss (or a corrupt entry).
 */
export function readSamCache(hash: string, concept: string): SamCachedResult | null {
  try {
    const raw = fs.readFileSync(samCachePath(hash, concept), 'utf8');
    return JSON.parse(raw) as SamCachedResult;
  } catch {
    return readSnapshotJson<SamCachedResult>(
      path.join('sam', hash, `${slug(concept)}.json`),
    );
  }
}
