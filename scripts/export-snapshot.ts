/**
 * Export the committed demo snapshot: copy every cached API result /lab and
 * /sim need for the committed clips into data/snapshot/ as JSON, so a fresh
 * deploy replays at $0. No raw API stream dumps; no derived images (stills
 * and thumbnails regenerate locally with ffmpeg, free).
 *
 * Usage: npx tsx scripts/export-snapshot.ts
 *
 * Copies: sam/ (summaries + boxes, all concepts), sam-image/ (stills
 * counts), verdict/, agent/ (demo + agent-check assessments), routes/
 * (main/detour + trip responses), places/ (nearby results), files.json
 * (content-hash → upload file id). Reports the total size (aim < 20 MB).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const SNAP_DIR = path.join(ROOT, 'data', 'snapshot');
const SIZE_WARN_MB = 20;

function fail(message: string): never {
  console.error(`export-snapshot: ${message}`);
  process.exit(1);
}

function copyTree(src: string, dest: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(src)) return { files, bytes };
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const r = copyTree(s, d);
      files += r.files;
      bytes += r.bytes;
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      files += 1;
      bytes += fs.statSync(d).size;
    }
  }
  return { files, bytes };
}

function copyFile(name: string): { files: number; bytes: number } {
  const src = path.join(CACHE_DIR, name);
  if (!fs.existsSync(src)) {
    console.log(`export-snapshot: ${name}: missing in cache, skipping.`);
    return { files: 0, bytes: 0 };
  }
  const dest = path.join(SNAP_DIR, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return { files: 1, bytes: fs.statSync(dest).size };
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  if (!fs.existsSync(CACHE_DIR)) fail('data/cache/ not found.');

  let files = 0;
  let bytes = 0;
  const take = (r: { files: number; bytes: number }, label: string): void => {
    files += r.files;
    bytes += r.bytes;
    console.log(
      `export-snapshot: ${label}: ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB.`,
    );
  };

  take(copyTree(path.join(CACHE_DIR, 'sam'), path.join(SNAP_DIR, 'sam')), 'sam');
  take(
    copyTree(path.join(CACHE_DIR, 'sam-image'), path.join(SNAP_DIR, 'sam-image')),
    'sam-image',
  );
  take(copyTree(path.join(CACHE_DIR, 'verdict'), path.join(SNAP_DIR, 'verdict')), 'verdict');
  take(copyTree(path.join(CACHE_DIR, 'agent'), path.join(SNAP_DIR, 'agent')), 'agent');
  take(copyTree(path.join(CACHE_DIR, 'routes'), path.join(SNAP_DIR, 'routes')), 'routes');
  take(copyTree(path.join(CACHE_DIR, 'places'), path.join(SNAP_DIR, 'places')), 'places');
  take(copyFile('files.json'), 'files.json');

  const mb = bytes / 1024 / 1024;
  console.log(`export-snapshot: total: ${files} files, ${mb.toFixed(1)} MB in data/snapshot/.`);
  if (mb > SIZE_WARN_MB) {
    console.log(
      `export-snapshot: WARNING: over the ${SIZE_WARN_MB} MB aim — drop mask data if needed (keep boxes).`,
    );
  }
}

main().catch((err) => {
  console.error(`export-snapshot: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
