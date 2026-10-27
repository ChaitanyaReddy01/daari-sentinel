import fs from 'node:fs';
import path from 'node:path';

import { hashFile } from './clips';
import { meta } from './meta';

const CACHE_PATH = path.join(process.cwd(), 'data', 'cache', 'files.json');

function loadCache(): Record<string, string> {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Upload a clip for SAM 3.1 input, keyed by content hash.
 * Never uploads the same bytes twice: a cached file id is returned as-is.
 */
export async function uploadClip(localPath: string): Promise<string> {
  const hash = hashFile(localPath);
  const cache = loadCache();
  const cached = cache[hash];
  if (typeof cached === 'string' && cached.length > 0) return cached;

  const file = await meta.files.create({
    purpose: 'user_data',
    file: fs.createReadStream(localPath),
  });

  cache[hash] = file.id;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  return file.id;
}
