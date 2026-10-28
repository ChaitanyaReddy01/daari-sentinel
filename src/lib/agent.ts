import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildChecks } from './checks';
import {
  MUSE_WONDER_MODEL,
  WONDER_MAX_OUTPUT_TOKENS,
  WONDER_REASONING_EFFORT,
  verdictCostUSD,
} from './config';
import { loadPreppedClip, preppedHash } from './clips';
import { readSamCache } from './sam-cache';
import type { SamCachedResult } from './sam';
import { readVerdictCache } from './verdict-cache';
import type { Verdict } from './verdict';
import {
  AGENT_JSON_SCHEMA,
  AGENT_SCHEMA_NAME,
  AgentAssessmentSchema,
  buildFallbackAssessment,
  guardAssessment,
  mapVerdictStage,
  type AgentAssessment,
  type AgentReportInput,
} from './agent-guard';
import { planningDefault, type PlanningDefault } from './clearance';
import { ledgerAppend } from './ledger';
import { assertLiveCalls, readSnapshotJson, writeCacheFile } from './snapshot';

/**
 * Muse Wonder incident agent (Step 5). Server-only: reads caches from disk
 * and bills the API on fresh assessments. Never import from client
 * components — the UI talks to /api/sim/assess instead.
 */

/** Bump to invalidate cached assessments (prompt or schema changed). */
export const AGENT_VERSION = 3;

export type { AgentAssessment, AgentReportInput };

// CONCEPTS duplicated from sam.ts (key-free): the agent builder must not need
// MODEL_API_KEY. Keep in sync with src/lib/sam.ts.
const AGENT_SAM_CONCEPTS = [
  'car',
  'truck',
  'police car',
  'ambulance',
  'fire truck',
  'tow truck',
  'person',
  'traffic cone',
  'construction vehicle',
  'road barrier',
  'safety vest',
];

// CHECK_CONCEPTS duplicated from the lab verdict route (key-free).
const CHECK_CONCEPTS = [
  'police car',
  'ambulance',
  'fire truck',
  'tow truck',
  'car',
  'truck',
  'person',
];

const SYSTEM_PROMPT =
  'You track one road incident over time from camera reports. Decide its current stage and how long until the road is clear. ' +
  'Give a RANGE, not a single number. Make the range wider when evidence is thin or unclear (one report only, night footage, lanes partly blocked with no sign of reopening, conflicting reports) ' +
  'and narrower when several consistent reports agree or clear signs show progress (tow truck loading, lanes reopening). ' +
  'Never claim responders, lanes or progress that no report supports. Cite evidence for every claim. ' +
  'You receive JSON with reports[] (reportId, minutesSinceFirstReport, clip, reporterDirection same|oncoming, verdict full JSON, samCounts per concept with 16+ marks, checks[]), previousAssessment or null, minutesSinceLastReport, timeOfDay day|night, and baseline {lowMin, likelyMin, highMin} planning defaults for the current type and stage. ' +
  'In this simulation, reports use stand-in footage from different real scenes. Do not treat differences in road type, camera angle or location between reports as conflicts. Do flag conflicting stage signals (e.g., tow seen, then no responders). ' +
  'Stages in order: no_responders, responders_on_scene, tow_in_progress, clearing, cleared. Prefer the furthest stage the reports support; do not move backward on a single conflicting stage signal. ' +
  'If the newest report finds no incident (verdict incident=false, free-flowing traffic), the stage MUST be cleared with highMin <= 5. ' +
  'Reports from oncoming cars (reporterDirection oncoming) are equally valid; treat them the same as same-direction reports. ' +
  'Clearance lowMin/likelyMin/highMin are minutes from NOW. Keep 0-240 with low<=likely<=high. likelyMin is the single most likely clearance time. ' +
  'Start from the baseline; move away from it only with evidence you cite in rangeReason, by at most 50% of the baseline bounds. ' +
  'Keep the range width (highMin minus lowMin) at most the baseline width, unless you set confidence low and say why. ' +
  'Set confidence low when evidence is thin (one report only), night footage limits visibility, the type is unknown, or stage signals conflict; say why in rangeReason or uncertainties. Otherwise use medium, or high when several consistent reports agree. ' +
  'A single clear day report with plainly visible blockage should come in slightly narrower than its baseline. ' +
  'Mention limited evidence and/or night in rangeReason whenever they apply. ' +
  'Three consistent reports showing tow progress must be narrower than a single initial report, even at night. ' +
  'lanes.blocked follows the newest verdict lanesBlocked; reopeningSoon is yes only when a report shows lanes reopening or a tow nearly done, no when blocked with no sign of reopening, else unknown. ' +
  'Evidence: 1-5 items of {reportId, second, claim}; every reportId must match an input report and every second must lie inside that clip. ' +
  'Every stage, lanes, and clearance claim must trace to at least one evidence item. ' +
  'changesSinceLast is at most 20 words, or exactly First report when previousAssessment is null. ' +
  'driverMessage is plain language for a driver, at most 25 words. uncertainties holds at most 3 short strings. ' +
  'rangeReason is at most 25 words, narrowsIf at most 20 words. Never invent responders, vehicles, lanes, or progress.';

const JSON_ONLY_SUFFIX =
  '\n\nRespond with JSON only, exactly matching this schema (no markdown, no commentary):\n' +
  JSON.stringify(AGENT_JSON_SCHEMA);

export interface AssessIncidentInput {
  reports: AgentReportInput[];
  previousAssessment: AgentAssessment | null;
  minutesSinceLastReport: number;
  timeOfDay: 'day' | 'night';
}

export interface StoredAssessment {
  assessment: AgentAssessment;
  source: 'muse-wonder' | 'fallback table';
  notes: string[];
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  estUSD: number;
  agentVersion: number;
}

const AGENT_DIR = path.join(process.cwd(), 'data', 'cache', 'agent');

export function agentCacheKeyFor(input: AssessIncidentInput): string {
  // Round minutes to 0.1 (6 s): demo fire times land a frame or two past
  // the mark, and replays must hit the same cache entry.
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        reports: input.reports.map((r) => ({
          ...r,
          minutesSinceFirstReport: round1(r.minutesSinceFirstReport),
        })),
        previousAssessment: input.previousAssessment,
        minutesSinceLastReport: round1(input.minutesSinceLastReport),
        timeOfDay: input.timeOfDay,
        v: AGENT_VERSION,
      }),
    )
    .digest('hex');
}

export function agentCachePath(key: string): string {
  return path.join(AGENT_DIR, `${key}.json`);
}

/** Cached assessment (data/cache/, then the snapshot); version mismatch is a miss. */
export function readAgentCache(key: string): StoredAssessment | null {
  let parsed: StoredAssessment | null = null;
  try {
    const raw = fs.readFileSync(agentCachePath(key), 'utf8');
    parsed = JSON.parse(raw) as StoredAssessment;
  } catch {
    parsed = readSnapshotJson<StoredAssessment>(path.join('agent', `${key}.json`));
  }
  if (!parsed || parsed.agentVersion !== AGENT_VERSION || !parsed.assessment) return null;
  return parsed;
}

/** Day or night from the clip verdict (night wording means night). */
export function timeOfDayFromVerdict(verdict: Verdict): 'day' | 'night' {
  return /night/i.test(`${verdict.summary} ${verdict.details}`) ? 'night' : 'day';
}

/**
 * Build one agent report input from cached clip data only. Throws when the
 * verdict is not cached — the agent never triggers new SAM or verdict calls.
 */
export function buildReportInput(args: {
  reportId: string;
  clip: string;
  direction: 'same' | 'oncoming';
  minutesSinceFirstReport: number;
}): AgentReportInput {
  const { reportId, clip, direction, minutesSinceFirstReport } = args;
  const clipInfo = loadPreppedClip(clip);
  if (!clipInfo) {
    throw new Error(`Unknown clip "${clip}". Prep it first: npx tsx scripts/prep-clip.ts ${clip}`);
  }
  const hash = preppedHash(clip);
  const verdictHit = readVerdictCache(hash);
  if (!verdictHit) {
    throw new Error(`No cached verdict for "${clip}" (run the batch first; agent uses cached data only).`);
  }
  const samCounts: Record<string, string> = {};
  for (const concept of AGENT_SAM_CONCEPTS) {
    const r = readSamCache(hash, concept);
    samCounts[concept] = !r ? 'unknown' : r.summary.objects === 16 ? '16+' : String(r.summary.objects);
  }
  const sam: Record<string, SamCachedResult | null> = {};
  for (const concept of CHECK_CONCEPTS) {
    sam[concept] = readSamCache(hash, concept);
  }
  return {
    reportId,
    minutesSinceFirstReport,
    clip,
    clipDurationSeconds: clipInfo.frameCount / clipInfo.fps,
    reporterDirection: direction,
    verdict: verdictHit.verdict,
    samCounts,
    checks: buildChecks({ verdict: verdictHit.verdict, sam, fps: clipInfo.fps }),
  };
}

/** Rough pre-run estimate per fresh assessment (Wonder token prices). */
export function estimateAgentCostUSD(numReports: number): number {
  return verdictCostUSD(MUSE_WONDER_MODEL, 800 + Math.max(1, numReports) * 1200, 600, 0);
}

async function appendAgentLedger(entry: {
  ts: string;
  model: string;
  hash: string;
  kind: 'agent';
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estUSD: number;
  source: 'muse-wonder' | 'fallback table';
}): Promise<void> {
  await ledgerAppend(entry as unknown as Record<string, unknown>);
}

function isFormatError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; message?: unknown };
  if (e.status !== 400) return false;
  return (
    typeof e.message === 'string' &&
    /json_schema|structured output|text\.format|response format/i.test(e.message)
  );
}

function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // Fall through to the fence-stripped attempt.
  }
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
  try {
    return { ok: true, value: JSON.parse(stripped) as unknown };
  } catch (err) {
    return {
      ok: false,
      error: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function storeAndLedger(args: {
  key: string;
  assessment: AgentAssessment;
  source: 'muse-wonder' | 'fallback table';
  notes: string[];
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}): Promise<StoredAssessment> {
  const estUSD = verdictCostUSD(
    MUSE_WONDER_MODEL,
    args.inputTokens,
    args.outputTokens,
    args.cachedInputTokens,
  );
  const stored: StoredAssessment = {
    assessment: args.assessment,
    source: args.source,
    notes: args.notes,
    usage: {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedInputTokens: args.cachedInputTokens,
    },
    estUSD,
    agentVersion: AGENT_VERSION,
  };
  writeCacheFile(agentCachePath(args.key), JSON.stringify(stored));
  await appendAgentLedger({
    ts: new Date().toISOString(),
    model: MUSE_WONDER_MODEL,
    hash: args.key,
    kind: 'agent',
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cachedInputTokens: args.cachedInputTokens,
    estUSD,
    source: args.source,
  });
  return stored;
}

/** Planning baseline for the newest report's type, stage, and severity. */
export function baselineFor(
  reports: AgentReportInput[],
): PlanningDefault {
  const latest = reports[reports.length - 1];
  const verdict = latest.verdict;
  if (verdict.type === 'construction') {
    return { lowMin: 60, likelyMin: 90, highMin: 120 };
  }
  return planningDefault(verdict.type, mapVerdictStage(verdict), verdict.severity);
}

/**
 * Assess one incident from its camera reports. Runs once per added report,
 * never per frame. Cached by report list + version; falls back to the
 * planning defaults when Wonder fails or stays invalid after one retry.
 */
export async function assessIncident(
  input: AssessIncidentInput,
): Promise<{ result: StoredAssessment; cached: boolean }> {
  if (!input.reports || input.reports.length === 0) {
    throw new Error('assessIncident needs at least one report.');
  }
  const key = agentCacheKeyFor(input);
  const hit = readAgentCache(key);
  if (hit) return { result: hit, cached: true };

  const baseline = baselineFor(input.reports);
  const baseUserText = JSON.stringify({
    reports: input.reports,
    previousAssessment: input.previousAssessment,
    minutesSinceLastReport: input.minutesSinceLastReport,
    timeOfDay: input.timeOfDay,
    baseline,
  });

  let meta: typeof import('./meta').meta;
  try {
    ({ meta } = await import('./meta'));
    assertLiveCalls(`Wonder assessment ${key.slice(0, 12)}…`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('is not in the local snapshot')) throw err;
    const fb = buildFallbackAssessment({
      reports: input.reports,
      previousAssessment: input.previousAssessment,
      reason: 'MODEL_API_KEY is not set',
    });
    return {
      result: await storeAndLedger({
        key,
        assessment: fb.assessment,
        source: 'fallback table',
        notes: fb.notes,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
      }),
      cached: false,
    };
  }

  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;

  const complete = async (userText: string, structured: boolean): Promise<string> => {
    const response = await meta.responses.create({
      model: MUSE_WONDER_MODEL,
      instructions: SYSTEM_PROMPT,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: userText }],
        },
      ],
      ...(structured
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: AGENT_SCHEMA_NAME,
                schema: AGENT_JSON_SCHEMA,
                strict: false,
              },
            },
          }
        : {}),
      reasoning: { effort: WONDER_REASONING_EFFORT },
      max_output_tokens: WONDER_MAX_OUTPUT_TOKENS,
    });
    const usage = response.usage as
      | {
          input_tokens?: unknown;
          output_tokens?: unknown;
          input_tokens_details?: { cached_tokens?: unknown };
        }
      | undefined;
    totalIn += num(usage?.input_tokens);
    totalOut += num(usage?.output_tokens);
    totalCached += num(usage?.input_tokens_details?.cached_tokens);
    const text = response.output_text;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Muse Wonder returned an empty response.');
    }
    return text;
  };

  const validate = (
    text: string,
  ): { ok: true; assessment: AgentAssessment; notes: string[] } | { ok: false; error: string } => {
    const parsed = extractJson(text);
    if (!parsed.ok) return parsed;
    const checked = AgentAssessmentSchema.safeParse(parsed.value);
    if (!checked.success) {
      return {
        ok: false,
        error: checked.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
    }
    const guarded = guardAssessment(checked.data, {
      reports: input.reports,
      previousAssessment: input.previousAssessment,
      baseline,
    });
    if (!guarded.valid || !guarded.assessment) {
      return { ok: false, error: guarded.errors.join('; ') || 'guard rejected the assessment' };
    }
    return { ok: true, assessment: guarded.assessment, notes: guarded.notes };
  };

  let structured = true;
  let firstText: string;
  try {
    firstText = await complete(baseUserText, true);
  } catch (err) {
    if (!isFormatError(err)) {
      // One retry on call failure, then the fallback table.
      try {
        firstText = await complete(baseUserText, true);
      } catch (err2) {
        const reason = err2 instanceof Error ? err2.message : String(err2);
        const fb = buildFallbackAssessment({
          reports: input.reports,
          previousAssessment: input.previousAssessment,
          reason: `Wonder call failed: ${reason}`,
        });
        return {
          result: await storeAndLedger({
            key,
            assessment: fb.assessment,
            source: 'fallback table',
            notes: fb.notes,
            inputTokens: totalIn,
            outputTokens: totalOut,
            cachedInputTokens: totalCached,
          }),
          cached: false,
        };
      }
    } else {
      structured = false;
      try {
        firstText = await complete(baseUserText + JSON_ONLY_SUFFIX, false);
      } catch (err2) {
        const reason = err2 instanceof Error ? err2.message : String(err2);
        const fb = buildFallbackAssessment({
          reports: input.reports,
          previousAssessment: input.previousAssessment,
          reason: `Wonder call failed: ${reason}`,
        });
        return {
          result: await storeAndLedger({
            key,
            assessment: fb.assessment,
            source: 'fallback table',
            notes: fb.notes,
            inputTokens: totalIn,
            outputTokens: totalOut,
            cachedInputTokens: totalCached,
          }),
          cached: false,
        };
      }
    }
  }

  const first = validate(firstText);
  if (first.ok) {
    return {
      result: await storeAndLedger({
        key,
        assessment: first.assessment,
        source: 'muse-wonder',
        notes: first.notes,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cachedInputTokens: totalCached,
      }),
      cached: false,
    };
  }

  const retryText =
    `${structured ? baseUserText : baseUserText + JSON_ONLY_SUFFIX}` +
    `\n\nYour previous response was invalid:\n${first.error}\n` +
    'Fix it and respond with JSON only, matching the schema.';
  let secondText: string;
  try {
    secondText = await complete(retryText, structured);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fb = buildFallbackAssessment({
      reports: input.reports,
      previousAssessment: input.previousAssessment,
      reason: `Wonder retry failed: ${reason}; first error: ${first.error}`,
    });
    return {
      result: await storeAndLedger({
        key,
        assessment: fb.assessment,
        source: 'fallback table',
        notes: fb.notes,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cachedInputTokens: totalCached,
      }),
      cached: false,
    };
  }
  const second = validate(secondText);
  if (second.ok) {
    return {
      result: await storeAndLedger({
        key,
        assessment: second.assessment,
        source: 'muse-wonder',
        notes: second.notes,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cachedInputTokens: totalCached,
      }),
      cached: false,
    };
  }

  const fb = buildFallbackAssessment({
    reports: input.reports,
    previousAssessment: input.previousAssessment,
    reason: `Wonder output invalid after retry: ${second.error}`,
  });
  return {
    result: await storeAndLedger({
      key,
      assessment: fb.assessment,
      source: 'fallback table',
      notes: fb.notes,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cachedInputTokens: totalCached,
    }),
    cached: false,
  };
}
