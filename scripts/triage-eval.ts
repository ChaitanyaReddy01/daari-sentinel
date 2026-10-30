/**
 * Triage ladder evaluation: Level 1 quick look on the 45% still of every
 * clip, plus Muse Spark verdicts at reasoning effort "low" (separate cache
 * keys, medium results untouched) compared against medium on incident, type
 * and responder accuracy.
 *
 * Usage: npx tsx scripts/triage-eval.ts [--yes]
 *
 * Prints a cost estimate and asks for "y" before any API call (skip with
 * --yes). Aborts over $3. Prints markdown tables to stdout and writes
 * data/snapshot/triage-ladder.json (per-clip quick looks + unit costs for
 * the /sim activity panel).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { hashFile, loadPreppedClip, preppedVideoPath } from '../src/lib/clips';
import { MUSE_SPARK_MODEL, verdictCostUSD } from '../src/lib/config';
import { estimateVerdictCost, readVerdictCache } from '../src/lib/verdict-cache';
import type { Verdict } from '../src/lib/verdict';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LABELS_PATH = path.join(ROOT, 'data', 'eval', 'labels.json');
const LADDER_PATH = path.join(ROOT, 'data', 'snapshot', 'triage-ladder.json');
const SPEND_ABORT_USD = 3;

/** Rough quick-look usage before any history exists (1 image, low effort). */
const QUICKLOOK_ESTIMATE_USD = verdictCostUSD(MUSE_SPARK_MODEL, 2000, 300);

interface Label {
  clip: string;
  incident: boolean;
  type: string;
  responders: { police: boolean; ambulance: boolean; fire: boolean; towTruck: boolean };
}

function fail(message: string): never {
  console.error(`triage-eval: ${message}`);
  process.exit(1);
}

function loadEnvKey(): void {
  const envPath = path.join(ROOT, '.env.local');
  if (!process.env.MODEL_API_KEY) {
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      const m = raw.match(/^MODEL_API_KEY=\s*(.+?)\s*$/m);
      if (m) process.env.MODEL_API_KEY = m[1].replace(/^"|"$/g, '');
    } catch {
      // Fall through to the check below.
    }
  }
  if (!process.env.MODEL_API_KEY) fail('MODEL_API_KEY is not set (checked env and .env.local).');
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
    if (!entry || typeof entry.clip !== 'string' || typeof entry.incident !== 'boolean') {
      fail(`malformed label entry: ${JSON.stringify(entry)}`);
    }
    map.set(entry.clip as string, entry as Label);
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function verdictScore(
  v: Verdict | null,
  label: Label | undefined,
): { incident: boolean | null; type: boolean | null; responders: number | null } {
  if (!v || !label) return { incident: null, type: null, responders: null };
  let respOk = 0;
  (['police', 'ambulance', 'fire', 'towTruck'] as const).forEach((k) => {
    if (v.responders[k] === label.responders[k]) respOk += 1;
  });
  return { incident: v.incident === label.incident, type: v.type === label.type, responders: respOk };
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  process.env.LIVE_CALLS = 'true';
  loadEnvKey();

  const { extractStill } = await import('../src/lib/stills');
  const { runQuicklook } = await import('../src/lib/quicklook');
  const { runVerdict } = await import('../src/lib/spark');

  const labels = loadLabels();
  const clips = Array.from(labels.keys()).filter((c) => loadPreppedClip(c) !== null).sort();
  if (clips.length === 0) fail('no labeled clips are prepped.');
  const synthPrepped = loadPreppedClip('synth-test') !== null;

  // --- Estimate (no API calls) ---
  let total = QUICKLOOK_ESTIMATE_USD * (clips.length + (synthPrepped ? 1 : 0));
  for (const clip of clips) {
    const info = loadPreppedClip(clip);
    if (info) total += estimateVerdictCost(MUSE_SPARK_MODEL, info.frameCount);
  }
  console.log(
    `triage-eval: estimate: ${clips.length + (synthPrepped ? 1 : 0)} quick looks × ` +
      `~$${QUICKLOOK_ESTIMATE_USD.toFixed(6)} + ${clips.length} low verdicts → $${total.toFixed(4)} (cached calls cost $0)`,
  );
  if (total > SPEND_ABORT_USD) {
    fail(`estimate $${total.toFixed(2)} exceeds the $${SPEND_ABORT_USD} abort limit.`);
  }
  if (!process.argv.includes('--yes') && !(await askYesNo('Proceed with the triage eval? [y/N] '))) {
    console.log('triage-eval: aborted by user.');
    process.exit(1);
  }

  // --- Run ---
  const quick: Record<string, { flag: string; reasons: string; confidence: number; cost: number; ms: number }> = {};
  let quickSpend = 0;
  const allForQuick = synthPrepped ? [...clips, 'synth-test'] : clips;
  for (const clip of allForQuick) {
    const info = loadPreppedClip(clip);
    if (!info) continue;
    const frame = Math.min(info.frameCount - 1, Math.max(0, Math.round(info.frameCount * 0.45)));
    const tmp = path.join(os.tmpdir(), `triage-${clip}-f${frame}.jpg`);
    extractStill(preppedVideoPath(clip), frame, info.fps, tmp);
    try {
      const started = Date.now();
      const { result, cached } = await runQuicklook({
        jpegBase64: fs.readFileSync(tmp).toString('base64'),
        hash: hashFile(tmp),
      });
      const ms = Date.now() - started;
      if (!cached) quickSpend += result.estUSD;
      quick[clip] = {
        flag: result.quicklook.flag,
        reasons: result.quicklook.reasons.join(',') || '—',
        confidence: result.quicklook.confidence,
        cost: result.estUSD,
        ms,
      };
      console.log(
        `triage-eval: ${clip} [quicklook f${frame}]: ${result.quicklook.flag} ` +
          `(${quick[clip].reasons}, conf ${result.quicklook.confidence.toFixed(2)})` +
          (cached ? ' (cached)' : ` ($${result.estUSD.toFixed(6)}, ${ms}ms)`),
      );
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best effort.
      }
    }
  }

  let lowSpend = 0;
  const lowVerdicts = new Map<string, Verdict>();
  for (const clip of clips) {
    const { result, cached } = await runVerdict({ clip, effort: 'low' });
    lowVerdicts.set(clip, result.verdict);
    if (!cached) lowSpend += result.estUSD;
    console.log(
      `triage-eval: ${clip} [verdict low]: incident=${result.verdict.incident} type=${result.verdict.type}` +
        (cached ? ' (cached)' : ` ($${result.estUSD.toFixed(6)})`),
    );
  }

  // --- Compare ---
  let qOk = 0;
  let qTotal = 0;
  const qFails: string[] = [];
  for (const clip of clips) {
    const label = labels.get(clip);
    const q = quick[clip];
    if (!label || !q) continue;
    qTotal += 1;
    const flagged = q.flag === 'suspicious';
    if (flagged === label.incident) qOk += 1;
    else qFails.push(`${clip} (label incident=${label.incident}, L1=${q.flag} [${q.reasons}])`);
  }

  const med = { incident: 0, type: 0, responders: 0, total: 0, respTotal: 0 };
  const low = { incident: 0, type: 0, responders: 0, total: 0, respTotal: 0 };
  for (const clip of clips) {
    const label = labels.get(clip);
    if (!label) continue;
    const info = loadPreppedClip(clip);
    if (!info) continue;
    const mv = readVerdictCache(hashFile(preppedVideoPath(clip)))?.verdict ?? null;
    const lv = lowVerdicts.get(clip) ?? null;
    const ms = verdictScore(mv, label);
    const ls = verdictScore(lv, label);
    if (ms.incident !== null) {
      med.total += 1;
      med.respTotal += 4;
      if (ms.incident) med.incident += 1;
      if (ms.type) med.type += 1;
      med.responders += ms.responders ?? 0;
    }
    if (ls.incident !== null) {
      low.total += 1;
      low.respTotal += 4;
      if (ls.incident) low.incident += 1;
      if (ls.type) low.type += 1;
      low.responders += ls.responders ?? 0;
    }
  }

  // --- Unit costs for the /sim panel (cached medians + fixed detect price) ---
  const quickCosts = clips.map((c) => quick[c]?.cost ?? 0).filter((n) => n > 0);
  const verdictCosts: number[] = [];
  for (const clip of clips) {
    const info = loadPreppedClip(clip);
    if (!info) continue;
    const hit = readVerdictCache(hashFile(preppedVideoPath(clip)));
    if (hit && hit.estUSD > 0) verdictCosts.push(hit.estUSD);
  }
  const assessCosts: number[] = [];
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'data', 'cache', 'agent'))) {
      if (!f.endsWith('.json')) continue;
      const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cache', 'agent', f), 'utf8')) as {
        estUSD?: unknown;
      };
      if (typeof parsed.estUSD === 'number' && parsed.estUSD > 0) assessCosts.push(parsed.estUSD);
    }
  } catch {
    // No agent cache; fall back below.
  }
  const unit = {
    quicklook: quickCosts.length > 0 ? median(quickCosts) : QUICKLOOK_ESTIMATE_USD,
    detect: 32 * (2.5 / 1000),
    verdict: verdictCosts.length > 0 ? median(verdictCosts) : 0.001,
    assess: assessCosts.length > 0 ? median(assessCosts) : 0.016,
  };
  const ladder = {
    quicklook: Object.fromEntries(
      clips.map((c) => [
        c,
        {
          flag: quick[c]?.flag ?? 'clear',
          reasons: quick[c]?.reasons ?? '—',
          confidence: quick[c]?.confidence ?? 0,
          cost: quick[c]?.cost ?? 0,
        },
      ]),
    ),
    costs: unit,
  };
  fs.mkdirSync(path.dirname(LADDER_PATH), { recursive: true });
  fs.writeFileSync(LADDER_PATH, `${JSON.stringify(ladder, null, 2)}\n`);
  console.log(`triage-eval: wrote ${LADDER_PATH}`);

  // --- Report to stdout ---
  const escRate = qTotal > 0 ? Object.values(quick).filter((q) => q.flag === 'suspicious').length / Math.max(1, clips.length) : 0;
  const fullCheck = unit.detect + unit.verdict + unit.assess;
  const costPerHour = 60 * unit.quicklook + 60 * escRate * fullCheck;
  console.log('');
  console.log('## Level 1 (45% still) — flag vs incident label');
  console.log('');
  console.log('| Clip | Label incident | L1 flag | Reasons | Match |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const clip of clips) {
    const label = labels.get(clip);
    const q = quick[clip];
    if (!label || !q) continue;
    const match = (q.flag === 'suspicious') === label.incident;
    console.log(`| ${clip} | ${label.incident} | ${q.flag} | ${q.reasons} | ${match ? '✓' : '✗'} |`);
  }
  console.log('');
  console.log(`L1 accuracy: ${qOk}/${qTotal}` + (qFails.length > 0 ? ` — misses: ${qFails.join('; ')}` : ''));
  console.log('');
  console.log('## Verdict effort: low vs medium');
  console.log('');
  console.log('| Effort | Incident | Type | Responders |');
  console.log('| --- | --- | --- | --- |');
  console.log(`| medium | ${med.incident}/${med.total} | ${med.type}/${med.total} | ${med.responders}/${med.respTotal} |`);
  console.log(`| low | ${low.incident}/${low.total} | ${low.type}/${low.total} | ${low.responders}/${low.respTotal} |`);
  console.log('');
  const lowWins =
    low.incident >= med.incident && low.type >= med.type && low.responders >= med.responders;
  console.log(lowWins ? 'DECISION: KEEP LOW' : 'DECISION: KEEP MEDIUM (default)');
  console.log('');
  console.log(`Escalation rate: ${(escRate * 100).toFixed(1)}% of clips flagged suspicious`);
  console.log(
    `Cost/hour at 1 quick look/min: 60×$${unit.quicklook.toFixed(6)} + ` +
      `60×${escRate.toFixed(3)}×$${fullCheck.toFixed(4)} (full check) = $${costPerHour.toFixed(4)}`,
  );
  console.log(`Eval spend (this run): quicklook $${quickSpend.toFixed(4)} + verdict-low $${lowSpend.toFixed(4)}`);
}

main().catch((err) => {
  console.error(`triage-eval: fatal: ${err instanceof Error && err.message ? err.message : String(err)}`);
  process.exit(1);
});
