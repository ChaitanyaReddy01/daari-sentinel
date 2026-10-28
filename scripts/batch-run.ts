/**
 * Batch evaluation: prep every raw clip, run all SAM concepts + the Muse
 * Spark verdict per clip, and write data/eval/batch-report.md.
 *
 * Usage: npx tsx scripts/batch-run.ts
 *
 * Prints a cost estimate and asks for "y" before any API call. Aborts over
 * $15. One clip at a time; a failed clip is logged and skipped, never
 * retried in a loop.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { hashFile, loadPreppedClip, preppedVideoPath } from '../src/lib/clips';
import { MUSE_SPARK_MODEL } from '../src/lib/config';
import { formatCount } from '../src/lib/format';
import { readSamCache } from '../src/lib/sam-cache';
import { PROMPT_VERSION, type Verdict } from '../src/lib/verdict';
import { readVerdictCache } from '../src/lib/verdict-cache';
import type { SamCachedResult } from '../src/lib/sam';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RAW_DIR = path.join(ROOT, 'clips', 'raw');
const PREPPED_DIR = path.join(ROOT, 'public', 'clips', 'prepped');
const LABELS_PATH = path.join(ROOT, 'data', 'eval', 'labels.json');
const REPORT_PATH = path.join(ROOT, 'data', 'eval', 'batch-report.md');
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);

const SAM_PRICE_PER_1K_FRAMES = 0.2;
const SAM_MIN_BILLABLE_FRAMES = 50;
const VERDICT_ESTIMATE_USD = 0.002;
const SPEND_ABORT_USD = 15;

interface Label {
  clip: string;
  incident: boolean;
  type: string;
  responders: { police: boolean; ambulance: boolean; fire: boolean; towTruck: boolean };
  notes: string;
  confirmed: boolean;
}

interface ClipRow {
  clip: string;
  frames: number;
  sizeBytes: number;
  width: number;
  height: number;
  objectsByConcept: Record<string, number | null>;
  trueCounts: Record<string, number | null>;
  verdict: Verdict | null;
  error: string | null;
}

function fail(message: string): never {
  console.error(`batch-run: ${message}`);
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

function rawClips(): string[] {
  if (!fs.existsSync(RAW_DIR)) fail(`raw clips directory not found: ${RAW_DIR}`);
  return fs
    .readdirSync(RAW_DIR)
    .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
    .filter((f) => !path.basename(f).startsWith('synth-'))
    .map((f) => path.basename(f, path.extname(f)))
    .sort();
}

function isPrepped(stem: string): boolean {
  return (
    fs.existsSync(path.join(PREPPED_DIR, `${stem}.mp4`)) &&
    fs.existsSync(path.join(PREPPED_DIR, `${stem}.json`))
  );
}

function loadLabels(): Map<string, Label> {
  let raw: string;
  try {
    raw = fs.readFileSync(LABELS_PATH, 'utf8');
  } catch {
    fail(`labels file not found: ${LABELS_PATH}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) fail('labels.json must be an array.');
  const map = new Map<string, Label>();
  for (const entry of parsed as Partial<Label>[]) {
    if (
      !entry ||
      typeof entry.clip !== 'string' ||
      typeof entry.incident !== 'boolean' ||
      typeof entry.type !== 'string' ||
      !entry.responders ||
      typeof entry.responders.police !== 'boolean' ||
      typeof entry.responders.ambulance !== 'boolean' ||
      typeof entry.responders.fire !== 'boolean' ||
      typeof entry.responders.towTruck !== 'boolean'
    ) {
      fail(`malformed label entry: ${JSON.stringify(entry)}`);
    }
    map.set(entry.clip, {
      clip: entry.clip,
      incident: entry.incident,
      type: entry.type,
      responders: entry.responders,
      notes: typeof entry.notes === 'string' ? entry.notes : '',
      confirmed: entry.confirmed === true,
    });
  }
  return map;
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

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function orientation(width: number, height: number): string {
  if (width > height) return 'landscape';
  if (height > width) return 'portrait';
  return 'square';
}

function errMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  process.env.LIVE_CALLS = 'true'; // live tool: gated API calls are intended
  loadEnvKey();

  // Keyed modules load only after the key is set.
  const sam = await import('../src/lib/sam');
  const files = await import('../src/lib/files');
  const spark = await import('../src/lib/spark');
  const stills = await import('../src/lib/stills');
  const { CONCEPTS, estimateCostUSD, getSpend, runSam } = sam;
  const { uploadClip } = files;
  const { runVerdict } = spark;
  const { STILLS_CONCEPTS, STILLS_PRICE_PER_IMAGE, readStillsCount, runStillsCount, stillFrames } =
    stills;

  // --- Prep pass (no API calls) ---
  const stems = rawClips();
  if (stems.length === 0) fail(`no video files found in ${RAW_DIR}`);
  const prepFailed = new Map<string, string>();
  for (const stem of stems) {
    if (isPrepped(stem)) {
      console.log(`batch-run: prep: ${stem} already prepped, skipping.`);
      continue;
    }
    console.log(`batch-run: prep: ${stem} ...`);
    try {
      execSync(`npx tsx scripts/prep-clip.ts ${stem}`, { stdio: 'inherit', cwd: ROOT });
    } catch {
      prepFailed.set(stem, 'prep-clip.ts failed (see ffmpeg output above)');
    }
  }
  const clips = stems.filter((s) => !prepFailed.has(s) && loadPreppedClip(s) !== null);
  prepFailed.forEach((error, stem) => {
    console.error(`batch-run: prep FAILED for ${stem}: ${error}`);
  });

  // --- Estimate pass (no API calls) ---
  const labels = loadLabels();
  let total = 0;
  for (const clip of clips) {
    const info = loadPreppedClip(clip);
    if (!info) continue;
    const hash = hashFile(preppedVideoPath(clip));
    let uncachedSam = 0;
    for (const concept of CONCEPTS) {
      if (!readSamCache(hash, concept)) uncachedSam += 1;
    }
    const samEst =
      uncachedSam * (Math.max(SAM_MIN_BILLABLE_FRAMES, info.frameCount) / 1000) *
      SAM_PRICE_PER_1K_FRAMES;
    const verdictEst = readVerdictCache(hash) ? 0 : VERDICT_ESTIMATE_USD;
    let uncachedStills = 0;
    for (const frame of stillFrames(info.frameCount, info.fps)) {
      for (const concept of STILLS_CONCEPTS) {
        if (readStillsCount(hash, frame, concept) === null) uncachedStills += 1;
      }
    }
    const stillsEst = uncachedStills * STILLS_PRICE_PER_IMAGE;
    const clipEst = samEst + stillsEst + verdictEst;
    total += clipEst;
    console.log(
      `batch-run: estimate: ${clip}: ${uncachedSam}/${CONCEPTS.length} SAM uncached × ` +
        `${Math.max(SAM_MIN_BILLABLE_FRAMES, info.frameCount)} frames = $${samEst.toFixed(4)}, ` +
        `stills ${uncachedStills}×$${STILLS_PRICE_PER_IMAGE.toFixed(4)}=$${stillsEst.toFixed(4)}, ` +
        `verdict ${verdictEst > 0 ? `≈$${verdictEst.toFixed(4)}` : '$0 (cached)'} → $${clipEst.toFixed(4)}`,
    );
  }
  console.log(`batch-run: estimate total: $${total.toFixed(4)}`);
  if (total > SPEND_ABORT_USD) {
    fail(`estimate $${total.toFixed(2)} exceeds the $${SPEND_ABORT_USD} abort limit.`);
  }
  if (!(await askYesNo('Proceed with the batch run? [y/N] '))) {
    console.log('batch-run: aborted by user.');
    process.exit(1);
  }

  // --- Run pass: one clip at a time, failures logged and skipped ---
  const rows: ClipRow[] = [];
  let batchSpend = 0;
  for (const clip of clips) {
    const info = loadPreppedClip(clip);
    if (!info) continue;
    const videoPath = preppedVideoPath(clip);
    const hash = hashFile(videoPath);
    const row: ClipRow = {
      clip,
      frames: info.frameCount,
      sizeBytes: info.sizeBytes,
      width: info.width,
      height: info.height,
      objectsByConcept: Object.fromEntries(CONCEPTS.map((c) => [c, null])),
      trueCounts: Object.fromEntries(STILLS_CONCEPTS.map((c) => [c, null])),
      verdict: null,
      error: null,
    };
    try {
      const fileId = await uploadClip(videoPath);
      const meta = {
        frameCount: info.frameCount,
        fps: info.fps,
        width: info.width,
        height: info.height,
      };
      for (const concept of CONCEPTS) {
        const wasCached = readSamCache(hash, concept) !== null;
        const result: SamCachedResult = await runSam({ fileId, hash, concept, meta });
        row.objectsByConcept[concept] = result.summary.objects;
        if (!wasCached) batchSpend += estimateCostUSD(info.frameCount);
        console.log(
          `batch-run: ${clip} [${concept}]: ${result.summary.objects} objects` +
            (wasCached ? ' (cached)' : ''),
        );
      }
      const { result: vresult, cached: vcached } = await runVerdict({ clip });
      row.verdict = vresult.verdict;
      if (!vcached) batchSpend += vresult.estUSD;
      console.log(
        `batch-run: ${clip} [verdict]: incident=${vresult.verdict.incident} ` +
          `type=${vresult.verdict.type}` +
          (vcached ? ' (cached)' : ` ($${vresult.estUSD.toFixed(6)})`),
      );
      for (const frame of stillFrames(info.frameCount, info.fps)) {
        for (const concept of STILLS_CONCEPTS) {
          const { count, cached: scached } = await runStillsCount({ clip, concept, frame });
          const prev = row.trueCounts[concept];
          row.trueCounts[concept] =
            prev === null || prev === undefined ? count : Math.max(prev, count);
          if (!scached) batchSpend += STILLS_PRICE_PER_IMAGE;
        }
      }
      console.log(
        `batch-run: ${clip} [stills true]: ` +
          STILLS_CONCEPTS.map((c) => `${c}=${row.trueCounts[c] ?? '—'}`).join(' '),
      );
    } catch (err) {
      row.error = errMessage(err);
      console.error(`batch-run: ${clip} FAILED: ${row.error} (skipping, continuing)`);
    }
    rows.push(row);
  }

  // --- Report ---
  const withVerdict = rows.filter((r) => r.verdict !== null);
  let incidentOk = 0;
  let incidentTotal = 0;
  let typeOk = 0;
  let typeTotal = 0;
  let respOk = 0;
  let respTotal = 0;
  const disagreeing: ClipRow[] = [];

  const table2Rows: string[] = [];
  for (const row of rows) {
    const label = labels.get(row.clip);
    const v = row.verdict;
    if (!v || !label) {
      table2Rows.push(
        `| ${row.clip} | — | — | — | — | — | ${row.error ? `FAILED: ${row.error}` : 'no verdict'} |`,
      );
      if (v && !label) disagreeing.push(row);
      continue;
    }
    const incidentMatch = v.incident === label.incident;
    const typeMatch = v.type === label.type;
    incidentTotal += 1;
    typeTotal += 1;
    if (incidentMatch) incidentOk += 1;
    if (typeMatch) typeOk += 1;
    const respMarks = (['police', 'ambulance', 'fire', 'towTruck'] as const).map((k) => {
      const match = v.responders[k] === label.responders[k];
      respTotal += 1;
      if (match) respOk += 1;
      return `${k === 'towTruck' ? 'T' : k[0].toUpperCase()}${match ? '✓' : '✗'}`;
    });
    if (!incidentMatch || !typeMatch || respMarks.some((m) => m.endsWith('✗'))) {
      disagreeing.push(row);
    }
    const incidentCell = incidentMatch ? `✓ ${v.incident}` : `✗ V:${v.incident} L:${label.incident}`;
    const typeCell = typeMatch ? `✓ ${v.type}` : `✗ V:${v.type} L:${label.type}`;
    const peopleCell = v.peopleOnRoad === null ? '—' : String(v.peopleOnRoad);
    const safeSummary = v.summary.replace(/\|/g, '/');
    table2Rows.push(
      `| ${row.clip} | ${incidentCell} | ${typeCell} | ${peopleCell} | ${v.stage} | ${respMarks.join(' ')} | ${safeSummary} |`,
    );
  }

  const conceptHeader = CONCEPTS.map((c) => c).join(' | ');
  const conceptSep = CONCEPTS.map(() => '---').join(' | ');
  const table1Rows = rows.map((r) => {
    const cells = CONCEPTS.map((c) => {
      const n = r.objectsByConcept[c];
      if (n === null || n === undefined) return '—';
      const t = r.trueCounts[c];
      const base = formatCount(n);
      return t === null || t === undefined ? base : `${base} (stills: ${t})`;
    });
    return `| ${r.clip} | ${r.frames} | ${fmtMB(r.sizeBytes)} | ${orientation(r.width, r.height)} | ${cells.join(' | ')} |`;
  });

  const failures = rows.filter((r) => r.error !== null);
  const lines = [
    '# Batch evaluation report',
    '',
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `SAM model: sam-3.1 · Spark model: ${MUSE_SPARK_MODEL} · Prompt version: ${PROMPT_VERSION}`,
    `Concepts (${CONCEPTS.length}): ${CONCEPTS.join(', ')}`,
    '',
    '## Table 1 — SAM objects per concept',
    '',
    `| Clip | Frames | Size | Orient | ${conceptHeader} |`,
    `| --- | --- | --- | --- | ${conceptSep} |`,
    ...table1Rows,
    '',
    'Counts of 16+ hit the video tracking cap (max 16 objects per frame). "stills" = max true count over 3 still frames (image mode, no cap).',
    '',
    '## Table 2 — Verdict vs ground truth',
    '',
    '| Clip | Incident | Type | People | Stage | Responders | Verdict summary |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...table2Rows,
    '',
    '## Totals',
    '',
    `- Incident accuracy: ${incidentOk}/${incidentTotal}`,
    `- Type accuracy: ${typeOk}/${typeTotal}`,
    `- Responder accuracy: ${respOk}/${respTotal}`,
    `- Batch spend (this run): $${batchSpend.toFixed(4)}`,
    `- Ledger total spend: $${getSpend().toFixed(4)}`,
    '',
    '## Disagreeing clips',
    '',
    ...(disagreeing.length === 0
      ? ['None — every verdict matched its label on incident, type, and responders.']
      : disagreeing.flatMap((r) => [
          `### ${r.clip}`,
          ...(r.verdict ? [r.verdict.summary] : ['No verdict.']),
          '',
        ])),
    '## Failures',
    '',
    ...(failures.length === 0
      ? ['None.']
      : failures.map((r) => `- ${r.clip}: ${r.error}`)),
    '',
  ];
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));

  console.log(`batch-run: wrote ${REPORT_PATH}`);
  console.log(
    `batch-run: incident ${incidentOk}/${incidentTotal}, type ${typeOk}/${typeTotal}, ` +
      `responders ${respOk}/${respTotal}, batch spend $${batchSpend.toFixed(4)}, ` +
      `ledger total $${getSpend().toFixed(4)}`,
  );
  if (failures.length > 0) {
    console.log(`batch-run: ${failures.length} clip(s) failed (see report).`);
  }
}

main().catch((err) => {
  console.error(`batch-run: fatal: ${errMessage(err)}`);
  process.exit(1);
});
