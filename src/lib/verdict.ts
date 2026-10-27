import { z } from 'zod';

/**
 * The scene verdict: what Muse Spark concludes is happening on the road.
 * Key-free: pure schema + validation, usable from routes and UI helpers.
 */

export const VerdictSchema = z.object({
  incident: z.boolean(),
  type: z.enum([
    'crash',
    'stalled_vehicle',
    'debris',
    'flooding',
    'police_activity',
    'construction',
    'none',
    'unknown',
  ]),
  severity: z.enum(['minor', 'moderate', 'severe']).nullable(),
  vehiclesInvolved: z.number().int().min(0).nullable(),
  lanesBlocked: z.enum(['none', 'shoulder', 'one', 'two', 'all', 'unknown']),
  responders: z.object({
    police: z.boolean(),
    ambulance: z.boolean(),
    fire: z.boolean(),
    towTruck: z.boolean(),
  }),
  stage: z.enum([
    'no_responders',
    'responders_on_scene',
    'tow_in_progress',
    'clearing',
    'cleared',
    'not_applicable',
  ]),
  hazards: z.array(z.string()),
  evidence: z
    .array(
      z.object({
        second: z.number().min(0),
        what: z.string().min(1),
      }),
    )
    .max(5),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
});

export type Verdict = z.infer<typeof VerdictSchema>;

/** Bump to invalidate cached verdicts (prompt or schema changed). */
export const PROMPT_VERSION = 1;

export const VERDICT_SCHEMA_NAME = 'SceneVerdict';

/**
 * Hand-written JSON Schema mirror of VerdictSchema for text.format structured
 * output. Plain JSON Schema, no recursion (the API rejects recursive schemas).
 * Keep in sync with VerdictSchema above.
 */
export const VERDICT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    incident: { type: 'boolean' },
    type: {
      type: 'string',
      enum: [
        'crash',
        'stalled_vehicle',
        'debris',
        'flooding',
        'police_activity',
        'construction',
        'none',
        'unknown',
      ],
    },
    severity: { type: ['string', 'null'], enum: ['minor', 'moderate', 'severe', null] },
    vehiclesInvolved: { type: ['integer', 'null'], minimum: 0 },
    lanesBlocked: {
      type: 'string',
      enum: ['none', 'shoulder', 'one', 'two', 'all', 'unknown'],
    },
    responders: {
      type: 'object',
      properties: {
        police: { type: 'boolean' },
        ambulance: { type: 'boolean' },
        fire: { type: 'boolean' },
        towTruck: { type: 'boolean' },
      },
      required: ['police', 'ambulance', 'fire', 'towTruck'],
      additionalProperties: false,
    },
    stage: {
      type: 'string',
      enum: [
        'no_responders',
        'responders_on_scene',
        'tow_in_progress',
        'clearing',
        'cleared',
        'not_applicable',
      ],
    },
    hazards: { type: 'array', items: { type: 'string' } },
    evidence: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          second: { type: 'number', minimum: 0 },
          what: { type: 'string', minLength: 1 },
        },
        required: ['second', 'what'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string', minLength: 1 },
  },
  required: [
    'incident',
    'type',
    'severity',
    'vehiclesInvolved',
    'lanesBlocked',
    'responders',
    'stage',
    'hazards',
    'evidence',
    'confidence',
    'summary',
  ],
  additionalProperties: false,
};
