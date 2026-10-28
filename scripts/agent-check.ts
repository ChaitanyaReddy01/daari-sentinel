/**
 * Agent check: three incident-agent scenarios over cached clip data.
 *
 * Usage: npx tsx scripts/agent-check.ts
 *
 * Uses cached SAM + verdict data only (no new SAM or verdict calls). Wonder
 * assessments bill the API unless cached. Prints a pass/fail table, ranges
 * per report, and total agent spend. Asks for "y" if the estimate tops $1.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { STAGE_ORDER } from '../src/lib/agent-guard';
import type { AgentAssessment } from '../src/lib/agent-guard';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEDGER_PATH = path.join(ROOT, 'data', 'ledger.jsonl');
const SPEND_PROMPT_USD = 1;

interface ScenarioReport {
  clip: string;
  direction: 'same' | 'oncoming';
  minutesSinceFirst: number;
}

interface AssessmentRecord {
  label: string;
  clips: string[];
  assessment: AgentAssessment;
  source: string;
  notes: string[];
  cached: boolean;
  estUSD: number;
  rangeReason: string;
}

function fail(message: string): never {
  console.error(`agent-check: ${message}`);
  process.exit(1);
}

function loadEnvKey(): boolean {
  if (process.env.MODEL_API_KEY) return true;
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
    const m = raw.match(/^MODEL_API_KEY=\s*(.+?)\s*$/m);
    if (m) {
      process.env.MODEL_API_KEY = m[1];
      return true;
    }
  } catch {
    // Fall through to the warning below.
  }
  return false;
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

function width(a: AgentAssessment): number {
  return a.clearance.highMin - a.clearance.lowMin;
}

function ledgerAgentTotal(): number {
  let total = 0;
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as { kind?: unknown; estUSD?: unknown };
        if (e.kind === 'agent' && typeof e.estUSD === 'number' && Number.isFinite(e.estUSD)) {
          total += e.estUSD;
        }
      } catch {
        // Skip malformed lines.
      }
    }
  } catch {
    // No ledger yet.
  }
  return total;
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  const hasKey = loadEnvKey();
  if (!hasKey) {
    console.log('agent-check: MODEL_API_KEY is not set — assessments will use the fallback table.');
  }

  const agent = await import('../src/lib/agent');
  const {
    assessIncident,
    buildReportInput,
    timeOfDayFromVerdict,
    agentCacheKeyFor,
    readAgentCache,
    estimateAgentCostUSD,
  } = agent;

  const scenarios: { name: string; reports: ScenarioReport[] }[] = [
    {
      name: 'A',
      reports: [
        { clip: 'crash-1', direction: 'same', minutesSinceFirst: 0 },
        { clip: 'car-tow-ambulance-police-1', direction: 'oncoming', minutesSinceFirst: 12 },
        { clip: 'car-police-tow-1', direction: 'same', minutesSinceFirst: 25 },
        { clip: 'dash-cam-car-1', direction: 'oncoming', minutesSinceFirst: 40 },
      ],
    },
    {
      name: 'B',
      reports: [{ clip: 'ambulance-fire-1', direction: 'same', minutesSinceFirst: 0 }],
    },
    {
      name: 'C',
      reports: [
        { clip: 'car-police-tow-1', direction: 'same', minutesSinceFirst: 0 },
        { clip: 'crash-1', direction: 'same', minutesSinceFirst: 10 },
      ],
    },
  ];

  // Build all prefix inputs first (cache-only; fails fast on missing data).
  const prefixes: { scenario: string; index: number; input: Parameters<typeof assessIncident>[0] }[] =
    [];
  for (const sc of scenarios) {
    const inputs = sc.reports.map((r, i) => {
      try {
        return buildReportInput({
          reportId: `r${i + 1}`,
          clip: r.clip,
          direction: r.direction,
          minutesSinceFirstReport: r.minutesSinceFirst,
        });
      } catch (err) {
        fail(
          `scenario ${sc.name} needs cached data for "${r.clip}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    // Chain previous assessments from cache when available, so estimate keys
    // match the real run order. Uncached prefixes use null (re-keyed at run).
    let prev: AgentAssessment | null = null;
    for (let i = 0; i < inputs.length; i++) {
      const slice = inputs.slice(0, i + 1);
      const last = sc.reports[i];
      const before = i > 0 ? sc.reports[i - 1].minutesSinceFirst : last.minutesSinceFirst;
      const input = {
        reports: slice,
        previousAssessment: prev,
        minutesSinceLastReport: Math.max(0, last.minutesSinceFirst - before),
        timeOfDay: timeOfDayFromVerdict(slice[slice.length - 1].verdict),
      };
      prefixes.push({ scenario: sc.name, index: i, input });
      const hit = readAgentCache(agentCacheKeyFor(input));
      if (hit) prev = hit.assessment;
      else prev = null;
    }
  }

  let estimate = 0;
  let cachedCount = 0;
  for (const p of prefixes) {
    if (readAgentCache(agentCacheKeyFor(p.input))) {
      cachedCount += 1;
    } else {
      estimate += estimateAgentCostUSD(p.input.reports.length);
    }
  }
  console.log(
    `agent-check: ${prefixes.length} assessments (${cachedCount} cached) — estimate $${estimate.toFixed(4)}`,
  );
  if (estimate > SPEND_PROMPT_USD) {
    if (!(await askYesNo(`Estimate $${estimate.toFixed(2)} is over $${SPEND_PROMPT_USD}. Proceed? [y/N] `))) {
      console.log('agent-check: aborted by user.');
      process.exit(1);
    }
  }

  // Run in scenario order, chaining live previous assessments.
  const records: AssessmentRecord[] = [];
  let runSpend = 0;
  for (const sc of scenarios) {
    const inputs = sc.reports.map((r, i) =>
      buildReportInput({
        reportId: `r${i + 1}`,
        clip: r.clip,
        direction: r.direction,
        minutesSinceFirstReport: r.minutesSinceFirst,
      }),
    );
    let prev: AgentAssessment | null = null;
    for (let i = 0; i < inputs.length; i++) {
      const slice = inputs.slice(0, i + 1);
      const last = sc.reports[i];
      const before = i > 0 ? sc.reports[i - 1].minutesSinceFirst : last.minutesSinceFirst;
      const { result, cached } = await assessIncident({
        reports: slice,
        previousAssessment: prev,
        minutesSinceLastReport: Math.max(0, last.minutesSinceFirst - before),
        timeOfDay: timeOfDayFromVerdict(slice[slice.length - 1].verdict),
      });
      prev = result.assessment;
      if (!cached) runSpend += result.estUSD;
      const c = result.assessment.clearance;
      console.log(
        `agent-check: ${sc.name}${i + 1} [${slice.map((s) => s.clip).join(' + ')}]: ` +
          `${result.assessment.stage} ${Math.round(c.lowMin)}-${Math.round(c.highMin)} min ` +
          `(${result.source}${cached ? ', cached' : ''})`,
      );
      records.push({
        label: `${sc.name}${i + 1}`,
        clips: slice.map((s) => s.clip),
        assessment: result.assessment,
        source: result.source,
        notes: result.notes,
        cached,
        estUSD: result.estUSD,
        rangeReason: result.assessment.rangeReason,
      });
    }
  }

  const byLabel = new Map(records.map((r) => [r.label, r]));
  const get = (label: string): AssessmentRecord => {
    const r = byLabel.get(label);
    if (!r) fail(`missing record ${label}`);
    return r;
  };

  const a1 = get('A1');
  const a3 = get('A3');
  const a4 = get('A4');
  const b1 = get('B1');
  const c1 = get('C1');
  const c2 = get('C2');

  const checks: { scenario: string; check: string; pass: boolean; detail: string }[] = [];
  checks.push({
    scenario: 'A',
    check: 'A1 width ≤ 45 min',
    pass: width(a1.assessment) <= 45,
    detail: `width ${width(a1.assessment).toFixed(0)}`,
  });
  checks.push({
    scenario: 'A',
    check: 'A3 width ≤ 20 min',
    pass: width(a3.assessment) <= 20,
    detail: `width ${width(a3.assessment).toFixed(0)}`,
  });
  checks.push({
    scenario: 'A',
    check: 'A3 likelyMin ≤ 20',
    pass: a3.assessment.clearance.likelyMin <= 20,
    detail: `likely ${a3.assessment.clearance.likelyMin.toFixed(0)}`,
  });
  checks.push({
    scenario: 'A',
    check: 'A ends cleared',
    pass: a4.assessment.stage === 'cleared',
    detail: a4.assessment.stage,
  });
  checks.push({
    scenario: 'B',
    check: 'B1 confidence low',
    pass: b1.assessment.confidence === 'low',
    detail: b1.assessment.confidence,
  });
  const noBackward = STAGE_ORDER[c2.assessment.stage] >= STAGE_ORDER[c1.assessment.stage];
  checks.push({
    scenario: 'C',
    check: 'guard keeps stage from going backward',
    pass: noBackward,
    detail: `${c1.assessment.stage} → ${c2.assessment.stage}`,
  });
  const c2notes = c2.notes.join(' ');
  const notedStageConflict =
    /conflict/i.test(c2notes) &&
    /no_responders|responders_on_scene|tow_in_progress|clearing|cleared/.test(c2notes);
  checks.push({
    scenario: 'C',
    check: 'guard notes the conflict on stage signals',
    pass: notedStageConflict,
    detail: c2notes || '(no notes)',
  });

  console.log('');
  console.log('| Scenario | Check | Result | Detail |');
  console.log('| --- | --- | --- | --- |');
  for (const c of checks) {
    console.log(`| ${c.scenario} | ${c.check} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '/')} |`);
  }
  console.log('');
  console.log('Ranges per report:');
  for (const r of records) {
    const c = r.assessment.clearance;
    console.log(
      `- ${r.label}: ${r.assessment.stage} ${c.lowMin.toFixed(0)}–${c.highMin.toFixed(0)} min ` +
        `(likely ${c.likelyMin.toFixed(0)}, ${r.assessment.confidence}) [${r.source}${r.cached ? ', cached' : ''}] — ${r.rangeReason}`,
    );
  }
  console.log('');
  console.log(`Total agent spend (this run): $${runSpend.toFixed(4)}`);
  console.log(`Ledger agent total: $${ledgerAgentTotal().toFixed(4)}`);

  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`agent-check: ${failed.length} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('agent-check: all green');
  }
}

main().catch((err) => {
  console.error(`agent-check: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
