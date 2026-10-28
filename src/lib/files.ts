import fs from 'node:fs';
import path from 'node:path';

import { hashFile } from './clips';
import { meta } from './meta';
import { assertLiveCalls, isProduction, readSnapshotJson, writeCacheFile } from './snapshot';

const CACHE_PATH = path.join(process.cwd(), 'data', 'cache', 'files.json');

function loadCache(): Record<string, string> {
  const snapshot = readSnapshotJson<Record<string, string>>('files.json') ?? {};
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...snapshot, ...(parsed as Record<string, string>) };
    }
    return snapshot;
  } catch {
    return snapshot;
  }
}

/**
 * Upload a clip for SAM 3.1 input, keyed by content hash.
 * Never uploads the same bytes twice: a cached file id is returned as-is.
 */
export async function uploadClip(localPath: string): Promise<string> {
  if (isProduction() && !fs.existsSync(localPath)) {
    // Production ships no video files: uploads are impossible, so this is a
    // snapshot miss, not a crash.
    assertLiveCalls(`Upload of ${localPath}`);
  }
  const hash = hashFile(localPath);
  const cache = loadCache();
  const cached = cache[hash];
  if (typeof cached === 'string' && cached.length > 0) return cached;
  assertLiveCalls(`Upload of ${localPath}`);

  const file = await meta.files.create({
    purpose: 'user_data',
    file: fs.createReadStream(localPath),
  });

  cache[hash] = file.id;
  writeCacheFile(CACHE_PATH, JSON.stringify(cache, null, 2));
  return file.id;
}
