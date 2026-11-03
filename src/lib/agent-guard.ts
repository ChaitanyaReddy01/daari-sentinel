import { z } from 'zod';

import type { VerdictCheck } from './checks';
import { clearanceEstimate, planningDefault, type PlanningDefault } from './clearance';
import type { Verdict } from './verdict';

/**
 * Verifiable incident-agent guard (Step 5). Browser-safe: zod + pure logic
 * only, no node imports — the sim UI imports display + types from here, and
 * the server agent imports the schema + guard + fallback.
 */

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export const AGENT_STAGES = [
  'no_responders',
  'responders_on_scene',
  'tow_in_progress',
  'clearing',
  'cleared',
] as const;

export type AgentStage = (typeof AGENT_STAGES)[number];

export const STAGE_ORDER: Record<AgentStage, number> = {
  no_responders: 0,
  responders_on_scene: 1,
  tow_in_progress: 2,
  clearing: 3,
  cleared: 4,
};

export const AgentEvidenceSchema = z.object({
  reportId: z.string().min(1),
  second: z.number().min(0),
  claim: z.string().min(1),
});

export type AgentEvidence = z.infer<typeof AgentEvidenceSchema>;

export const AgentAssessmentSchema = z.object({
  stage: z.enum(AGENT_STAGES),
  stageConfidence: z.number().min(0).max(1),
  clearance: z.object({
    lowMin: z.number().min(0).max(240),
    likelyMin: z.number().min(0).max(240),
    highMin: z.number().min(0).max(240),
  }),
  confidence: z.enum(['high', 'medium', 'low']),
  rangeReason: z
    .string()
    .min(1)
    .refine((s) => wordCount(s) <= 25, 'rangeReason must be at most 25 words'),
  narrowsIf: z
    .string()
    .min(1)
    .refine((s) => wordCount(s) <= 20, 'narrowsIf must be at most 20 words'),
  lanes: z.object({
    blocked: z.enum(['none', 'shoulder', 'one', 'two', 'all', 'unknown']),
    reopeningSoon: z.enum(['yes', 'no', 'unknown']),
  }),
  evidence: z.array(AgentEvidenceSchema).min(1).max(5),
  changesSinceLast: z
    .string()
    .min(1)
    .refine((s) => wordCount(s) <= 20, 'changesSinceLast must be at most 20 words'),
  driverMessage: z
    .string()
    .min(1)
    .refine((s) => wordCount(s) <= 25, 'driverMessage must be at most 25 words'),
  uncertainties: z.array(z.string().min(1)).max(3),
});

export type AgentAssessment = z.infer<typeof AgentAssessmentSchema>;

export const AGENT_SCHEMA_NAME = 'IncidentAssessment';

/**
 * Hand-written JSON Schema mirror of AgentAssessmentSchema for text.format
 * structured output. Plain JSON Schema, no recursion. Keep in sync.
 */
export const AGENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    stage: { type: 'string', enum: [...AGENT_STAGES] },
    stageConfidence: { type: 'number', minimum: 0, maximum: 1 },
    clearance: {
      type: 'object',
      properties: {
        lowMin: { type: 'number', minimum: 0, maximum: 240 },
        likelyMin: { type: 'number', minimum: 0, maximum: 240 },
        highMin: { type: 'number', minimum: 0, maximum: 240 },
      },
      required: ['lowMin', 'likelyMin', 'highMin'],
      additionalProperties: false,
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'low when evidence is thin, night, or conflicting',
    },
    rangeReason: {
      type: 'string',
      minLength: 1,
      description: 'Why the range is this wide, max 25 words.',
    },
    narrowsIf: {
      type: 'string',
      minLength: 1,
      description: 'What next sighting would narrow it, max 20 words.',
    },
    lanes: {
      type: 'object',
      properties: {
        blocked: {
          type: 'string',
          enum: ['none', 'shoulder', 'one', 'two', 'all', 'unknown'],
        },
        reopeningSoon: { type: 'string', enum: ['yes', 'no', 'unknown'] },
      },
      required: ['blocked', 'reopeningSoon'],
      additionalProperties: false,
    },
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          reportId: { type: 'string', minLength: 1 },
          second: { type: 'number', minimum: 0 },
          claim: { type: 'string', minLength: 1 },
        },
        required: ['reportId', 'second', 'claim'],
        additionalProperties: false,
      },
    },
    changesSinceLast: {
      type: 'string',
      minLength: 1,
      description: 'Max 20 words; "First report" if no previous.',
    },
    driverMessage: {
      type: 'string',
      minLength: 1,
      description: 'Plain language for a driver, max 25 words.',
    },
    uncertainties: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', minLength: 1 },
    },
  },
  required: [
    'stage',
    'stageConfidence',
    'clearance',
    'confidence',
    'rangeReason',
    'narrowsIf',
    'lanes',
    'evidence',
    'changesSinceLast',
    'driverMessage',
    'uncertainties',
  ],
  additionalProperties: false,
};

/** One camera report as the agent sees it (built server-side from caches). */
export interface AgentReportInput {
  reportId: string;
  minutesSinceFirstReport: number;
  clip: string;
  clipDurationSeconds: number;
  reporterDirection: 'same' | 'oncoming';
  verdict: Verdict;
  /** Per-concept display counts ("0", "3", "16+", "unknown"). */
  samCounts: Record<string, string>;
  checks: VerdictCheck[];
}

/** Map a clip verdict stage onto the agent stage ladder. */
export function mapVerdictStage(verdict: Verdict): AgentStage {
  if (!verdict.incident) return 'cleared';
  switch (verdict.stage) {
    case 'no_responders':
    case 'responders_on_scene':
    case 'tow_in_progress':
    case 'clearing':
    case 'cleared':
      return verdict.stage;
    default:
      return 'no_responders';
  }
}

function verdictShowsResponders(verdict: Verdict): boolean {
  const r = verdict.responders;
  return r.police || r.ambulance || r.fire || r.towTruck;
}

const RESPONDER_CONCEPTS = [
  'police car',
  'ambulance',
  'fire truck',
  'tow truck',
  'safety vest',
];

function samCountValue(display: string | undefined): number {
  if (!display || display === 'unknown') return 0;
  if (display === '16+') return 16;
  const n = parseInt(display, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function samShowsResponders(samCounts: Record<string, string>): boolean {
  return RESPONDER_CONCEPTS.some((c) => samCountValue(samCounts[c]) > 0);
}

function reportSupportsResponders(report: AgentReportInput): boolean {
  return verdictShowsResponders(report.verdict) || samShowsResponders(report.samCounts);
}

export interface GuardResult {
  valid: boolean;
  assessment: AgentAssessment | null;
  notes: string[];
  errors: string[];
}

/**
 * Verify a candidate assessment. Evidence drops invalid items (none left =
 * invalid); range ordering/bounds/cleared rule = invalid for retry; backward
 * stages, unsupported responder stages, and over-wide ranges are auto-fixed
 * with notes.
 */
export function guardAssessment(
  candidate: AgentAssessment,
  ctx: {
    reports: AgentReportInput[];
    previousAssessment: AgentAssessment | null;
    baseline: PlanningDefault;
  },
): GuardResult {
  const notes: string[] = [];
  const { reports, previousAssessment, baseline } = ctx;

  const byId = new Map(reports.map((r) => [r.reportId, r]));
  const cleaned: AgentEvidence[] = [];
  for (const e of candidate.evidence) {
    const report = byId.get(e.reportId);
    if (!report) continue;
    if (e.second > report.clipDurationSeconds) continue;
    cleaned.push(e);
  }
  if (cleaned.length === 0) {
    return {
      valid: false,
      assessment: null,
      notes: ['All evidence items were invalid (unknown report or second past the clip end).'],
      errors: [
        'evidence: every item must reference an existing reportId and a second inside that clip',
      ],
    };
  }
  if (cleaned.length < candidate.evidence.length) {
    notes.push(`Dropped ${candidate.evidence.length - cleaned.length} invalid evidence item(s).`);
  }

  const { lowMin, likelyMin, highMin } = candidate.clearance;
  const rangeErrors: string[] = [];
  if (!(lowMin <= likelyMin && likelyMin <= highMin)) {
    rangeErrors.push(
      `clearance: need lowMin <= likelyMin <= highMin (got ${lowMin}/${likelyMin}/${highMin})`,
    );
  }
  if (candidate.stage === 'cleared' && highMin > 5) {
    rangeErrors.push(`clearance: stage cleared requires highMin <= 5 (got ${highMin})`);
  }
  if (rangeErrors.length > 0) {
    return { valid: false, assessment: null, notes, errors: rangeErrors };
  }

  const fixed: AgentAssessment = {
    ...candidate,
    clearance: { ...candidate.clearance },
    lanes: { ...candidate.lanes },
    evidence: cleaned,
    uncertainties: [...candidate.uncertainties],
  };

  // Backward guard: allow only a one-step correction the newest verdict
  // names; anything further back is treated as conflicting reports.
  let blockedBackward = false;
  if (previousAssessment) {
    const prevOrder = STAGE_ORDER[previousAssessment.stage];
    const candOrder = STAGE_ORDER[fixed.stage];
    if (candOrder < prevOrder) {
      const latest = reports[reports.length - 1];
      const latestMapped = latest ? mapVerdictStage(latest.verdict) : null;
      const oneStep = prevOrder - candOrder === 1;
      if (latestMapped === fixed.stage && oneStep) {
        notes.push(`Stage moved back to ${fixed.stage}; the newest report supports it.`);
      } else {
        blockedBackward = true;
        notes.push(
          `Conflicting report: kept stage ${previousAssessment.stage} instead of ${fixed.stage}.`,
        );
        fixed.stage = previousAssessment.stage;
        fixed.stageConfidence = Math.min(fixed.stageConfidence, previousAssessment.stageConfidence);
        if (fixed.uncertainties.length < 3) {
          fixed.uncertainties.push('Conflicting reports; keeping prior stage.');
        }
      }
    }
    // Note verdict-level conflict even when the candidate did not regress,
    // so scenario C always records the disagreement.
    if (!blockedBackward && reports.length > 0) {
      const latest = reports[reports.length - 1];
      const mapped = mapVerdictStage(latest.verdict);
      if (STAGE_ORDER[mapped] < prevOrder) {
        notes.push(`Latest report conflicts with prior stage (${previousAssessment.stage} vs ${mapped}).`);
        if (fixed.uncertainties.length < 3) {
          fixed.uncertainties.push('Latest report conflicts with prior evidence.');
        }
      }
    }
  }

  if (fixed.stage === 'responders_on_scene' || fixed.stage === 'tow_in_progress') {
    const supported = reports.some(reportSupportsResponders);
    if (!supported) {
      const from = fixed.stage;
      fixed.stage = 'no_responders';
      const width = fixed.clearance.highMin - fixed.clearance.lowMin;
      const newWidth = width * 1.5;
      const likely = fixed.clearance.likelyMin;
      fixed.clearance = {
        lowMin: Math.max(0, Math.round(likely - newWidth / 2)),
        likelyMin: likely,
        highMin: Math.min(240, Math.round(likely + newWidth / 2)),
      };
      notes.push(`Downgraded ${from} to no_responders: no report shows responders; widened range 50%.`);
      if (fixed.uncertainties.length < 3) {
        fixed.uncertainties.push('No responder evidence; widened range.');
      }
    }
  }

  // Width clamp: wider than the planning baseline needs low confidence.
  const baseWidth = baseline.highMin - baseline.lowMin;
  const fixedWidth = fixed.clearance.highMin - fixed.clearance.lowMin;
  if (baseWidth > 0 && fixedWidth > baseWidth && fixed.confidence !== 'low') {
    const likely = fixed.clearance.likelyMin;
    fixed.clearance = {
      lowMin: Math.min(likely, Math.max(0, Math.round(likely - baseWidth / 2))),
      likelyMin: likely,
      highMin: Math.max(likely, Math.min(240, Math.round(likely + baseWidth / 2))),
    };
    notes.push(`Clamped range to the ${baseWidth}-min baseline width around likelyMin.`);
  }

  return { valid: true, assessment: fixed, notes, errors: [] };
}

/** Fallback assessment from the v2 planning defaults (wonder failed or invalid). */
export function buildFallbackAssessment(args: {
  reports: AgentReportInput[];
  previousAssessment: AgentAssessment | null;
  reason: string;
}): { assessment: AgentAssessment; notes: string[] } {
  const { reports, previousAssessment, reason } = args;
  const latest = reports[reports.length - 1];
  if (!latest) throw new Error('buildFallbackAssessment needs at least one report.');
  const verdict = latest.verdict;
  const stage = mapVerdictStage(verdict);
  const baseline =
    verdict.type === 'construction'
      ? { lowMin: 60, likelyMin: 90, highMin: 120 }
      : planningDefault(verdict.type, stage, verdict.severity);
  const { lowMin, likelyMin, highMin } = baseline;
  const firstEvidence = verdict.evidence[0];
  const evidence: AgentEvidence[] =
    firstEvidence !== undefined
      ? [
          {
            reportId: latest.reportId,
            second: Math.min(firstEvidence.second, latest.clipDurationSeconds),
            claim: firstEvidence.what.slice(0, 120),
          },
        ]
      : [{ reportId: latest.reportId, second: 0, claim: verdict.summary.slice(0, 120) }];

  const candidate: AgentAssessment = {
    stage,
    stageConfidence: 0.5,
    clearance: { lowMin, likelyMin, highMin },
    confidence: 'medium',
    rangeReason: 'Fallback estimate from clearance table.',
    narrowsIf: 'Next camera report confirms scene.',
    lanes: {
      blocked: verdict.lanesBlocked,
      reopeningSoon: stage === 'cleared' || stage === 'clearing' ? 'yes' : 'unknown',
    },
    evidence,
    changesSinceLast: previousAssessment ? 'Fallback estimate updated.' : 'First report',
    driverMessage: verdict.summary,
    uncertainties: ['Fallback table estimate, not AI assessment'],
  };
  const guarded = guardAssessment(candidate, { reports, previousAssessment, baseline });
  const notes = [`Fallback table used: ${reason}`, ...guarded.notes];
  if (guarded.valid && guarded.assessment) {
    return { assessment: guarded.assessment, notes };
  }
  return { assessment: candidate, notes };
}

/** Warn each distinct corruption once per session (render + scoring are hot). */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[clearance] ${message}`);
}

function asFinite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export interface SafeClearance {
  lowMin: number;
  likelyMin: number;
  highMin: number;
  /** True when any end was missing/non-finite and filled from fallback. */
  fixed: boolean;
}

/**
 * Guarantee finite clearance ends for scoring and display. A missing or
 * non-finite low/high falls back to the planning defaults for the
 * type+stage; a missing likelyMin derives from the midpoint of the known
 * ends. The result is ordered low<=likely<=high. Repairs are warned once.
 */
export function safeClearance(
  clearance: { lowMin?: unknown; likelyMin?: unknown; highMin?: unknown } | null | undefined,
  fallback: PlanningDefault,
  tag: string,
): SafeClearance {
  const lowIn = asFinite(clearance?.lowMin);
  const likelyIn = asFinite(clearance?.likelyMin);
  const highIn = asFinite(clearance?.highMin);
  const low = lowIn ?? fallback.lowMin;
  const high = highIn ?? fallback.highMin;
  const likely = likelyIn ?? Math.round((low + high) / 2);
  const ordered = low <= likely && likely <= high;
  const fixed = lowIn === null || likelyIn === null || highIn === null || !ordered;
  if (fixed) {
    warnOnce(
      `${tag}:${JSON.stringify(clearance)}`,
      `${tag}: incomplete clearance ${JSON.stringify(clearance)}; using low=${low} likely=${likely} high=${high}.`,
    );
  }
  return {
    lowMin: Math.min(low, likely, high),
    likelyMin: Math.min(Math.max(likely, low), high),
    highMin: Math.max(low, likely, high),
    fixed,
  };
}

/** Remaining clearance after minutesSinceAssessment, floored at 0. Never NaN. */
export function displayClearance(
  assessment: AgentAssessment,
  minutesSinceAssessment: number,
  hasClearedReport: boolean,
  planning?: PlanningDefault,
): {
  lowMin: number;
  likelyMin: number;
  highMin: number;
  unconfirmed: boolean;
  unconfirmedLabel: string | null;
} {
  const elapsed = asFinite(minutesSinceAssessment) ?? 0;
  if (asFinite(minutesSinceAssessment) === null) {
    warnOnce('age', `non-finite assessment age (${String(minutesSinceAssessment)}); treating as 0.`);
  }
  const c = safeClearance(
    assessment.clearance,
    planning ?? { lowMin: 0, likelyMin: 0, highMin: 0 },
    'display',
  );
  if (!hasClearedReport && elapsed > c.highMin) {
    return {
      lowMin: 0,
      likelyMin: 5,
      highMin: 10,
      unconfirmed: true,
      unconfirmedLabel: 'Likely clearing, unconfirmed: waiting for the next camera pass',
    };
  }
  return {
    lowMin: Math.max(0, Math.round(c.lowMin - Math.max(0, elapsed))),
    likelyMin: Math.max(0, Math.round(c.likelyMin - Math.max(0, elapsed))),
    highMin: Math.max(0, Math.round(c.highMin - Math.max(0, elapsed))),
    unconfirmed: false,
    unconfirmedLabel: null,
  };
}

/** Minimal incident shape for range resolution (scoring + display share it). */
export interface RangeIncident {
  assessments: { assessment: AgentAssessment; atT: number }[];
  reports: { t: number; incident: boolean }[];
  type: string;
  stage: string;
  severity: string | null;
}

/**
 * An incident's clearance range remaining now: the latest assessment aged
 * to simNow, else the planning table (work zones read as zero). Never NaN:
 * a non-finite assessment age counts as 0 and incomplete ends fall back to
 * the planning defaults for the incident's type and stage.
 */
export function resolveIncidentRange(
  inc: RangeIncident,
  simNow: number,
): { lo: number; likely: number; hi: number } {
  const latest = inc.assessments[inc.assessments.length - 1] ?? null;
  if (latest) {
    const atT = asFinite(latest.atT) ?? simNow;
    const rem = displayClearance(
      latest.assessment,
      (simNow - atT) / 60,
      inc.reports.some((r) => !r.incident),
      planningDefault(inc.type, inc.stage, inc.severity),
    );
    return { lo: rem.lowMin, likely: rem.likelyMin, hi: rem.highMin };
  }
  const clear = clearanceEstimate(inc.type, inc.stage, inc.severity);
  if (clear.loMin === null || clear.likelyMin === null || clear.hiMin === null) {
    return { lo: 0, likely: 0, hi: 0 };
  }
  return { lo: clear.loMin, likely: clear.likelyMin, hi: clear.hiMin };
}
