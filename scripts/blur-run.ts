/**
 * Privacy-blur pass: run SAM 3.1 video tracking for "face" and "license
 * plate" over every prepped clip, cached like the other concepts. The boxes
 * drive scripts/blur-clips.ts, which renders the blurred display copies.
 *
 * Usage: npx tsx scripts/blur-run.ts [--yes]
 *
 * Prints a cost estimate and asks for "y" before any API call (skip the
 * prompt with --yes when the spend was already confirmed). Aborts over $5.
 * One clip at a time; a failed clip is logged and skipped, never retried
 * in a loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { hashFile, listPreppedClips, preppedVideoPath } from '../src/lib/clips';
import { readSamCache } from '../src/lib/sam-cache';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const BLUR_CONCEPTS = ['face', 'license plate'];
const SPEND_ABORT_USD = 5;

function fail(message: string): never {
  console.error(`blur-run: ${message}`);
  process.exit(1);
}

function loadEnvKey(): void {
  const envPath = path.join(ROOT, '.env.local');
  if (!process.env.MODEL_API_KEY) {
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      const m = raw.match(/^MODEL_API_KEY=\s*(.+?)\s*$/m);
      if (m) process.env.MODEL_API_KEY = m[1];
    } catch {
      // Fall through to the check below.
    }
  }
  if (!process.env.MODEL_API_KEY) fail('MODEL_API_KEY is not set (checked env and .env.local).');
}

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const t = answer.trim().toLowerCase();
      resolve(t === 'y' || t === 'yes');
    });
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  process.env.LIVE_CALLS = 'true'; // live tool: gated API calls are intended
  loadEnvKey();

  const sam = await import('../src/lib/sam');
  const files = await import('../src/lib/files');
  const { estimateCostUSD, runSam } = sam;
  const { uploadClip } = files;

  const clips = listPreppedClips();
  if (clips.length === 0) fail('no prepped clips found.');

  // --- Estimate pass (no API calls) ---
  let total = 0;
  let calls = 0;
  for (const clip of clips) {
    const hash = hashFile(preppedVideoPath(clip.name));
    const uncached = BLUR_CONCEPTS.filter((c) => !readSamCache(hash, c));
    const clipEst = uncached.length * estimateCostUSD(clip.frameCount);
    total += clipEst;
    calls += uncached.length;
    console.log(
      `blur-run: estimate: ${clip.name}: ${uncached.length}/${BLUR_CONCEPTS.length} uncached ` +
        `× ${Math.max(50, clip.frameCount)} frames → $${clipEst.toFixed(4)}`,
    );
  }
  console.log(`blur-run: estimate total: ${calls} calls = $${total.toFixed(4)}`);
  if (total > SPEND_ABORT_USD) {
    fail(`estimate $${total.toFixed(2)} exceeds the $${SPEND_ABORT_USD} abort limit.`);
  }
  if (!process.argv.includes('--yes')) {
    if (!(await askYesNo('Run the blur SAM pass? [y/N] '))) {
      console.log('blur-run: aborted by user.');
      process.exit(1);
    }
  }

  // --- Run pass ---
  let batchSpend = 0;
  const failures: string[] = [];
  for (const clip of clips) {
    const videoPath = preppedVideoPath(clip.name);
    const hash = hashFile(videoPath);
    const meta = {
      frameCount: clip.frameCount,
      fps: clip.fps,
      width: clip.width,
      height: clip.height,
    };
    try {
      const fileId = await uploadClip(videoPath);
      for (const concept of BLUR_CONCEPTS) {
        const wasCached = readSamCache(hash, concept) !== null;
        const result = await runSam({ fileId, hash, concept, meta });
        if (!wasCached) batchSpend += estimateCostUSD(clip.frameCount);
        console.log(
          `blur-run: ${clip.name} [${concept}]: ${result.summary.objects} objects` +
            (wasCached ? ' (cached)' : ''),
        );
      }
    } catch (err) {
      failures.push(`${clip.name}: ${errMessage(err)}`);
      console.error(`blur-run: ${clip.name} FAILED: ${errMessage(err)} (skipping, continuing)`);
    }
  }

  console.log(`blur-run: done, batch spend $${batchSpend.toFixed(4)}.`);
  if (failures.length > 0) {
    console.log(`blur-run: ${failures.length} clip(s) failed:`);
    for (const f of failures) console.log(`blur-run:   ${f}`);
  }
}

main().catch((err) => {
  console.error(`blur-run: fatal: ${errMessage(err)}`);
  process.exit(1);
});
