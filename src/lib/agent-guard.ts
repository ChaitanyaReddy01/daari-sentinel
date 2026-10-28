import { z } from 'zod';

import type { VerdictCheck } from './checks';
import { clearanceEstimate } from './clearance';
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
    midMin: z.number().min(0).max(240),
    highMin: z.number().min(0).max(240),
  }),
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
        midMin: { type: 'number', minimum: 0, maximum: 240 },
        highMin: { type: 'number', minimum: 0, maximum: 240 },
      },
      required: ['lowMin', 'midMin', 'highMin'],
      additionalProperties: false,
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
 * stages and unsupported responder stages are auto-fixed with notes.
 */
export function guardAssessment(
  candidate: AgentAssessment,
  ctx: { reports: AgentReportInput[]; previousAssessment: AgentAssessment | null },
): GuardResult {
  const notes: string[] = [];
  const { reports, previousAssessment } = ctx;

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

  const { lowMin, midMin, highMin } = candidate.clearance;
  const rangeErrors: string[] = [];
  if (!(lowMin <= midMin && midMin <= highMin)) {
    rangeErrors.push(`clearance: need lowMin <= midMin <= highMin (got ${lowMin}/${midMin}/${highMin})`);
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
      const mid = fixed.clearance.midMin;
      fixed.clearance = {
        lowMin: Math.max(0, Math.round(mid - newWidth / 2)),
        midMin: mid,
        highMin: Math.min(240, Math.round(mid + newWidth / 2)),
      };
      notes.push(`Downgraded ${from} to no_responders: no report shows responders; widened range 50%.`);
      if (fixed.uncertainties.length < 3) {
        fixed.uncertainties.push('No responder evidence; widened range.');
      }
    }
  }

  return { valid: true, assessment: fixed, notes, errors: [] };
}

/** Fallback assessment from CLEARANCE_TABLE v1 (wonder failed or invalid). */
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
  const tableType =
    verdict.type === 'crash' || verdict.type === 'police_activity' || verdict.type === 'fire'
      ? verdict.type
      : 'other';
  const est = clearanceEstimate(tableType, stage, verdict.severity);
  let lowMin = est.loMin;
  let midMin = est.midpointMin === null ? null : Math.round(est.midpointMin);
  let highMin = est.hiMin;
  if (lowMin === null || midMin === null || highMin === null) {
    lowMin = 60;
    midMin = 90;
    highMin = 120;
  }
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
    clearance: { lowMin, midMin, highMin },
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
  const guarded = guardAssessment(candidate, { reports, previousAssessment });
  const notes = [`Fallback table used: ${reason}`, ...guarded.notes];
  if (guarded.valid && guarded.assessment) {
    return { assessment: guarded.assessment, notes };
  }
  return { assessment: candidate, notes };
}

/** Remaining clearance after minutesSinceAssessment, floored at 0. */
export function displayClearance(
  assessment: AgentAssessment,
  minutesSinceAssessment: number,
  hasClearedReport: boolean,
): {
  lowMin: number;
  midMin: number;
  highMin: number;
  unconfirmed: boolean;
  unconfirmedLabel: string | null;
} {
  const elapsed = Math.max(0, minutesSinceAssessment);
  if (!hasClearedReport && elapsed > assessment.clearance.highMin) {
    return {
      lowMin: 0,
      midMin: 5,
      highMin: 10,
      unconfirmed: true,
      unconfirmedLabel: 'Likely clearing, unconfirmed: waiting for the next camera pass',
    };
  }
  return {
    lowMin: Math.max(0, Math.round(assessment.clearance.lowMin - elapsed)),
    midMin: Math.max(0, Math.round(assessment.clearance.midMin - elapsed)),
    highMin: Math.max(0, Math.round(assessment.clearance.highMin - elapsed)),
    unconfirmed: false,
    unconfirmedLabel: null,
  };
}
