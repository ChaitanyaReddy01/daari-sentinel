import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { hashFile } from './clips';
import { MUSE_SPARK_MODEL, verdictCostUSD } from './config';
import { uploadClip } from './files';
import { ledgerAppend } from './ledger';
import { meta } from './meta';
import { assertLiveCalls, readSnapshotJson, writeCacheFile } from './snapshot';

/**
 * Level 1 quick look: one still frame, Muse Spark contributor, low effort.
 * Decides only whether the frame shows anything a driver behind would need
 * to know about. Cached by frame hash; fresh calls bill under "quicklook".
 */

export const QuicklookSchema = z.object({
  flag: z.enum(['clear', 'suspicious']),
  reasons: z
    .array(
      z.enum(['crash', 'responders', 'hazard', 'work_zone', 'stopped_traffic', 'fire', 'other']),
    )
    .max(7),
  confidence: z.number().min(0).max(1),
});

export type Quicklook = z.infer<typeof QuicklookSchema>;

const QUICKLOOK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    flag: { type: 'string', enum: ['clear', 'suspicious'] },
    reasons: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['crash', 'responders', 'hazard', 'work_zone', 'stopped_traffic', 'fire', 'other'],
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['flag', 'reasons', 'confidence'],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  'You are a traffic camera triage filter. Look at one still frame and decide only ' +
  'whether it shows anything a driver approaching this spot would need to know about: ' +
  'a crash, emergency responders at work, a hazard on the road, a work zone, stopped ' +
  'traffic, or fire. Normal flowing traffic is "clear" even if heavy. A parked police ' +
  'car with no incident around it is "clear". When in doubt about a real hazard, flag ' +
  '"suspicious" — a later stage will check. Reply with JSON only.';

const JSON_ONLY_SUFFIX =
  '\n\nRespond with JSON only, exactly matching this schema (no markdown, no commentary):\n' +
  JSON.stringify(QUICKLOOK_JSON_SCHEMA);

const QUICKLOOK_VERSION = 1;
const QUICKLOOK_DIR = path.join(process.cwd(), 'data', 'cache', 'quicklook');
/** Image request with low effort: small output budget, reasoning shares it. */
const QUICKLOOK_MAX_OUTPUT_TOKENS = 1500;

export interface QuicklookCachedResult {
  version: number;
  model: string;
  quicklook: Quicklook;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  estUSD: number;
}

export function quicklookCachePath(hash: string): string {
  return path.join(QUICKLOOK_DIR, `${hash}.json`);
}

function readQuicklookCache(hash: string): QuicklookCachedResult | null {
  let parsed: QuicklookCachedResult | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(quicklookCachePath(hash), 'utf8')) as QuicklookCachedResult;
  } catch {
    parsed = readSnapshotJson<QuicklookCachedResult>(path.join('quicklook', `${hash}.json`));
  }
  if (!parsed || parsed.version !== QUICKLOOK_VERSION || !parsed.quicklook) return null;
  return parsed;
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

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function validateQuicklook(
  text: string,
): { ok: true; quicklook: Quicklook } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    const stripped = text
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '');
    try {
      value = JSON.parse(stripped) as unknown;
    } catch (err) {
      return {
        ok: false,
        error: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const checked = QuicklookSchema.safeParse(value);
  if (!checked.success) {
    return {
      ok: false,
      error: checked.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, quicklook: checked.data };
}

/**
 * Run Level 1 on one still image. Cached by frame hash; /try passes
 * liveAuthorized (its own quota/budget guards already ran).
 */
export async function runQuicklook(
  args: { imagePath: string; hash?: string },
  opts?: { liveAuthorized?: boolean },
): Promise<{ result: QuicklookCachedResult; cached: boolean }> {
  const hash = args.hash ?? hashFile(args.imagePath);
  const hit = readQuicklookCache(hash);
  if (hit) return { result: hit, cached: true };
  if (!opts?.liveAuthorized) assertLiveCalls(`Quick look on ${args.imagePath}`);

  const fileId = await uploadClip(args.imagePath);
  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;

  const complete = async (userText: string, structured: boolean): Promise<string> => {
    const message = {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: userText },
        { type: 'input_image', file_id: fileId },
      ],
    };
    const response = await meta.responses.create({
      model: MUSE_SPARK_MODEL,
      instructions: SYSTEM_PROMPT,
      input: [message] as unknown as Parameters<typeof meta.responses.create>[0]['input'],
      ...(structured
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: 'QuickLook',
                schema: QUICKLOOK_JSON_SCHEMA,
                strict: false,
              },
            },
          }
        : {}),
      reasoning: { effort: 'low' },
      max_output_tokens: QUICKLOOK_MAX_OUTPUT_TOKENS,
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
      throw new Error('Quick look returned an empty response.');
    }
    return text;
  };

  const baseUserText = 'Triage this frame for a driver behind.';
  let structured = true;
  let text: string;
  try {
    text = await complete(baseUserText, true);
  } catch (err) {
    if (!isFormatError(err)) throw err;
    structured = false;
    text = await complete(baseUserText + JSON_ONLY_SUFFIX, false);
  }

  let checked = validateQuicklook(text);
  if (!checked.ok) {
    const retryText =
      `${structured ? baseUserText : baseUserText + JSON_ONLY_SUFFIX}` +
      `\n\nYour previous response was invalid:\n${checked.error}\n` +
      'Fix it and respond with JSON only, matching the schema.';
    text = await complete(retryText, structured);
    checked = validateQuicklook(text);
    if (!checked.ok) {
      throw new Error(`Quick look failed validation: ${checked.error}`);
    }
  }

  const estUSD = verdictCostUSD(MUSE_SPARK_MODEL, totalIn, totalOut, totalCached);
  const out: QuicklookCachedResult = {
    version: QUICKLOOK_VERSION,
    model: MUSE_SPARK_MODEL,
    quicklook: checked.quicklook,
    usage: { inputTokens: totalIn, outputTokens: totalOut, cachedInputTokens: totalCached },
    estUSD,
  };
  writeCacheFile(quicklookCachePath(hash), JSON.stringify(out));
  await ledgerAppend({
    ts: new Date().toISOString(),
    model: MUSE_SPARK_MODEL,
    hash,
    kind: 'quicklook',
    inputTokens: totalIn,
    outputTokens: totalOut,
    cachedInputTokens: totalCached,
    estUSD,
  });
  return { result: out, cached: false };
}
