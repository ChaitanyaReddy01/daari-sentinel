import { meta } from './meta';
import { uploadClip } from './files';
import { loadPreppedClip, preppedHash, preppedVideoPath } from './clips';
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
import { ledgerAppend } from './ledger';
import { assertLiveCalls, writeCacheFile } from './snapshot';

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

export interface VerdictLedgerEntry {
  ts: string;
  model: string;
  hash: string;
  kind: 'verdict';
  inputTokens: number;
  outputTokens: number;
  estUSD: number;
}

async function appendVerdictLedger(entry: VerdictLedgerEntry): Promise<void> {
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

export type SparkVideoContent =
  | { type: 'input_file'; file_id: string }
  | { type: 'input_video'; video_url: string };

export interface SparkVerdictOutcome {
  verdict: Verdict;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * One structured scene verdict from Muse Spark. Structured output first;
 * JSON-only fallback if the model rejects text.format; one validation
 * retry; then a clear error. Shared by clip verdicts and /try URL verdicts.
 */
export async function requestSparkVerdict(args: {
  video: SparkVideoContent;
  baseUserText: string;
}): Promise<SparkVerdictOutcome> {
  const { video, baseUserText } = args;
  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;

  const complete = async (userText: string, structured: boolean): Promise<string> => {
    const message = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: userText }, video],
    };
    const response = await meta.responses.create({
      model: MUSE_SPARK_MODEL,
      instructions: SYSTEM_PROMPT,
      // input_video is API-supported but missing from the SDK types; the cast
      // stays at this boundary.
      input: [message] as unknown as Parameters<typeof meta.responses.create>[0]['input'],
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

  return {
    verdict: checked.verdict,
    inputTokens: totalIn,
    outputTokens: totalOut,
    cachedTokens: totalCached,
  };
}

/**
 * Ask Muse Spark for a structured scene verdict over a prepped clip, reusing
 * the cached Files API upload.
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
  const hash = preppedHash(clip);

  const hit = readVerdictCache(hash);
  if (hit) return { result: hit, cached: true };
  assertLiveCalls(`Spark verdict on ${clip}`);

  const fileId = await uploadClip(videoPath);
  const baseUserText =
    `${samHints(hash)}\n\nDescribe the scene using the schema. ` +
    'The summary must be one sentence of at most 25 words, written for a driver; ' +
    'put the longer scene description in details (max 80 words).';
  const outcome = await requestSparkVerdict({
    video: { type: 'input_file', file_id: fileId },
    baseUserText,
  });

  const estUSD = verdictCostUSD(
    MUSE_SPARK_MODEL,
    outcome.inputTokens,
    outcome.outputTokens,
    outcome.cachedTokens,
  );
  const out: VerdictCachedResult = {
    promptVersion: PROMPT_VERSION,
    model: MUSE_SPARK_MODEL,
    verdict: outcome.verdict,
    usage: {
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      cachedInputTokens: outcome.cachedTokens,
    },
    estUSD,
  };
  writeCacheFile(verdictCachePath(hash), JSON.stringify(out));
  await appendVerdictLedger({
    ts: new Date().toISOString(),
    model: MUSE_SPARK_MODEL,
    hash,
    kind: 'verdict',
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    estUSD,
  });

  return { result: out, cached: false };
}

/**
 * Scene verdict over a remote video URL (/try flow). No cache, no ledger
 * here — the caller records the real cost under its own ledger kind.
 */
export async function runVerdictFromUrl({
  videoUrl,
  hintsText,
}: {
  videoUrl: string;
  hintsText: string;
}): Promise<SparkVerdictOutcome & { estUSD: number }> {
  const baseUserText =
    `${hintsText}\n\nDescribe the scene using the schema. ` +
    'The summary must be one sentence of at most 25 words, written for a driver; ' +
    'put the longer scene description in details (max 80 words). ' +
    "First decide if this shows a road, street, highway, or traffic scene. If it does not, set incident=false and type='none', and begin the summary with exactly 'Not road footage:'.";
  const outcome = await requestSparkVerdict({
    video: { type: 'input_video', video_url: videoUrl },
    baseUserText,
  });
  const estUSD = verdictCostUSD(
    MUSE_SPARK_MODEL,
    outcome.inputTokens,
    outcome.outputTokens,
    outcome.cachedTokens,
  );
  return { ...outcome, estUSD };
}
