import fs from 'node:fs';
import path from 'node:path';

import { meta } from './meta';
import { uploadClip } from './files';
import { hashFile, loadPreppedClip, preppedVideoPath } from './clips';
import { readSamCache } from './sam-cache';
import { CONCEPTS } from './sam';
import {
  MUSE_SPARK_MODEL,
  REASONING_EFFORT,
  SPARK_MAX_OUTPUT_TOKENS,
  verdictCostUSD,
} from './config';
import {
  PROMPT_VERSION,
  VERDICT_JSON_SCHEMA,
  VERDICT_SCHEMA_NAME,
  VerdictSchema,
  type Verdict,
} from './verdict';
import {
  readVerdictCache,
  verdictCachePath,
  type VerdictCachedResult,
} from './verdict-cache';

/**
 * Muse Spark scene verdict. Keyed: every fresh call bills the API, so results
 * are cached by clip hash and every billed call is appended to the ledger.
 */

const SYSTEM_PROMPT =
  "You are a traffic incident analyst reviewing road camera footage. Report only what is visible. If unsure, use 'unknown' or false. Never invent responders that are not visible. " +
  'When incident is false, the summary must be neutral and must not tell drivers to avoid the area (e.g. "No incident; heavy but normal traffic.").';

const JSON_ONLY_SUFFIX =
  '\n\nRespond with JSON only, exactly matching this schema (no markdown, no commentary):\n' +
  JSON.stringify(VERDICT_JSON_SCHEMA);

const PLURALS: Record<string, string> = {
  car: 'cars',
  truck: 'trucks',
  'police car': 'police cars',
  ambulance: 'ambulances',
  'fire truck': 'fire trucks',
  'tow truck': 'tow trucks',
  person: 'persons',
  'traffic cone': 'traffic cones',
};

/** One-line SAM summary used as hints in the verdict prompt. */
export function samHints(hash: string): string {
  const parts: string[] = [];
  for (const concept of CONCEPTS) {
    const r = readSamCache(hash, concept);
    if (!r) continue;
    const n = r.summary.objects;
    const label = n === 1 ? concept : (PLURALS[concept] ?? `${concept}s`);
    const frames =
      r.summary.firstFrame !== null && r.summary.lastFrame !== null
        ? ` (frames ${r.summary.firstFrame}–${r.summary.lastFrame})`
        : '';
    parts.push(`${n} ${label}${frames}`);
  }
  if (parts.length === 0) return 'Object tracker has no data for this clip yet.';
  return `Object tracker found: ${parts.join(', ')}.`;
}

const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');

export interface VerdictLedgerEntry {
  ts: string;
  model: string;
  hash: string;
  kind: 'verdict';
  inputTokens: number;
  outputTokens: number;
  estUSD: number;
}

function appendVerdictLedger(entry: VerdictLedgerEntry): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
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

function validateVerdict(
  text: string,
): { ok: true; verdict: Verdict } | { ok: false; error: string } {
  const parsed = extractJson(text);
  if (!parsed.ok) return parsed;
  const checked = VerdictSchema.safeParse(parsed.value);
  if (!checked.success) {
    return {
      ok: false,
      error: checked.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, verdict: checked.data };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Ask Muse Spark for a structured scene verdict over a prepped clip, reusing
 * the cached Files API upload. Structured output first; JSON-only fallback if
 * the model rejects text.format; one validation retry; then a clear error.
 */
export async function runVerdict({
  clip,
}: {
  clip: string;
}): Promise<{ result: VerdictCachedResult; cached: boolean }> {
  const clipInfo = loadPreppedClip(clip);
  if (!clipInfo) {
    throw new Error(`Unknown clip "${clip}". Prep it first: npx tsx scripts/prep-clip.ts ${clip}`);
  }
  const videoPath = preppedVideoPath(clip);
  const hash = hashFile(videoPath);

  const hit = readVerdictCache(hash);
  if (hit) return { result: hit, cached: true };

  const fileId = await uploadClip(videoPath);
  const baseUserText =
    `${samHints(hash)}\n\nDescribe the scene using the schema. ` +
    'The summary must be one sentence of at most 25 words, written for a driver; ' +
    'put the longer scene description in details (max 80 words).';

  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;

  const complete = async (userText: string, structured: boolean): Promise<string> => {
    const response = await meta.responses.create({
      model: MUSE_SPARK_MODEL,
      instructions: SYSTEM_PROMPT,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            { type: 'input_file', file_id: fileId },
          ],
        },
      ],
      ...(structured
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: VERDICT_SCHEMA_NAME,
                schema: VERDICT_JSON_SCHEMA,
                strict: false,
              },
            },
          }
        : {}),
      reasoning: { effort: REASONING_EFFORT },
      max_output_tokens: SPARK_MAX_OUTPUT_TOKENS,
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
      throw new Error('Muse Spark returned an empty response (possibly cut off by max_output_tokens).');
    }
    return text;
  };

  let structured = true;
  let userText = baseUserText;
  let text: string;
  try {
    text = await complete(userText, true);
  } catch (err) {
    if (!isFormatError(err)) throw err;
    structured = false;
    userText = baseUserText + JSON_ONLY_SUFFIX;
    text = await complete(userText, false);
  }

  let checked = validateVerdict(text);
  if (!checked.ok) {
    const firstError = checked.error;
    const retryText =
      `${structured ? baseUserText : baseUserText + JSON_ONLY_SUFFIX}` +
      `\n\nYour previous response was invalid:\n${firstError}\n` +
      'Fix it and respond with JSON only, matching the schema.';
    text = await complete(retryText, structured);
    checked = validateVerdict(text);
    if (!checked.ok) {
      throw new Error(`Muse Spark verdict failed validation: ${checked.error}`);
    }
  }

  const estUSD = verdictCostUSD(MUSE_SPARK_MODEL, totalIn, totalOut, totalCached);
  const out: VerdictCachedResult = {
    promptVersion: PROMPT_VERSION,
    model: MUSE_SPARK_MODEL,
    verdict: checked.verdict,
    usage: { inputTokens: totalIn, outputTokens: totalOut, cachedInputTokens: totalCached },
    estUSD,
  };
  fs.mkdirSync(path.dirname(verdictCachePath(hash)), { recursive: true });
  fs.writeFileSync(verdictCachePath(hash), JSON.stringify(out));
  appendVerdictLedger({
    ts: new Date().toISOString(),
    model: MUSE_SPARK_MODEL,
    hash,
    kind: 'verdict',
    inputTokens: totalIn,
    outputTokens: totalOut,
    estUSD,
  });

  return { result: out, cached: false };
}
