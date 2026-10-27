import fs from 'node:fs';
import path from 'node:path';

import { parseVideoStream, recordsOfKind } from '@meta-sam/parser';
import type { ResponseInputMessageItem } from 'openai/resources/responses/responses';

import { meta } from './meta';
import { readSamCache, samCachePath, slug } from './sam-cache';

export { readSamCache, samCachePath, slug };

export const CONCEPTS = [
  'crashed car',
  'police car',
  'tow truck',
  'ambulance',
  'fire truck',
  'standing water',
  'traffic cone',
  'road debris',
];

export const SAM_MODEL = 'sam-3.1';
export const PRICE_PER_1K_FRAMES = 0.2;
export const MIN_BILLABLE_FRAMES = 50;
export const LAB_BUDGET_USD = 150;

export interface ClipMeta {
  frameCount: number;
  fps: number;
  width: number;
  height: number;
}

export interface SamBox {
  frame: number;
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c: number | null;
}

export interface SamSummary {
  concept: string;
  objects: number;
  firstFrame: number | null;
  lastFrame: number | null;
  maxConfidence: number | null;
}

export interface SamCachedResult {
  summary: SamSummary;
  boxes: SamBox[];
  width: number;
  height: number;
  fps: number;
}

export interface LedgerEntry {
  ts: string;
  model: string;
  hash: string;
  concept: string;
  frames: number;
  estUSD: number;
}

const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');

/** Billable frames for one SAM request: frame count, minimum 50. */
export function billableFrames(frameCount: number): number {
  return Math.max(MIN_BILLABLE_FRAMES, frameCount);
}

/** Estimated USD for one SAM request over a clip with frameCount frames. */
export function estimateCostUSD(frameCount: number): number {
  return (billableFrames(frameCount) / 1000) * PRICE_PER_1K_FRAMES;
}

export function appendLedger(entry: LedgerEntry): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
}

/** Total estimated spend across every real (non-cached) SAM call. */
export function getSpend(): number {
  let total = 0;
  let raw: string;
  try {
    raw = fs.readFileSync(LEDGER_PATH, 'utf8');
  } catch {
    return 0;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<LedgerEntry>;
      if (typeof entry.estUSD === 'number' && Number.isFinite(entry.estUSD)) {
        total += entry.estUSD;
      }
    } catch {
      // Skip malformed ledger lines.
    }
  }
  return total;
}

/**
 * Run SAM 3.1 tracking for ONE short noun-phrase concept over an uploaded clip.
 * SAM rule: no lists, no commands, no questions. Zero matches is a normal
 * result, not an error.
 */
export async function runSam({
  fileId,
  hash,
  concept,
  meta: clipMeta,
}: {
  fileId: string;
  hash: string;
  concept: string;
  meta: ClipMeta;
}): Promise<SamCachedResult> {
  const cached = readSamCache(hash, concept);
  if (cached) return cached;

  // `input_video` is a Meta Responses extension over the OpenAI-compatible
  // input shape, so the message needs a cast at this boundary.
  const message = {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: concept },
      { type: 'input_video', file_id: fileId },
    ],
  } as unknown as ResponseInputMessageItem;

  const events = await meta.responses.create({
    model: SAM_MODEL,
    input: [message],
    stream: true,
    metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
  });

  const result = await parseVideoStream(events).finalResult;
  if (result.outcome.status !== 'completed') {
    console.warn(`[sam] ${concept}: outcome=${JSON.stringify(result.outcome)} (keeping parsed records)`);
  }
  for (const diagnostic of result.diagnostics) {
    console.warn(
      `[sam] ${concept}: diagnostic ${diagnostic.severity} ${diagnostic.code} ` +
        `on line ${diagnostic.line}: ${diagnostic.message}`,
    );
  }

  const boxes: SamBox[] = recordsOfKind(result.records, 'box').map((b) => ({
    frame: b.frame?.frameIndex ?? 0,
    id: b.objectId,
    x1: b.left,
    y1: b.top,
    x2: b.right,
    y2: b.bottom,
    c: b.confidence ?? null,
  }));

  const ids = new Set(boxes.map((b) => b.id));
  const frames = boxes.map((b) => b.frame);
  const confidences = boxes.map((b) => b.c).filter((c): c is number => typeof c === 'number');
  const summary: SamSummary = {
    concept,
    objects: ids.size,
    firstFrame: frames.length > 0 ? Math.min(...frames) : null,
    lastFrame: frames.length > 0 ? Math.max(...frames) : null,
    maxConfidence: confidences.length > 0 ? Math.max(...confidences) : null,
  };

  const out: SamCachedResult = {
    summary,
    boxes,
    width: clipMeta.width,
    height: clipMeta.height,
    fps: clipMeta.fps,
  };
  const outPath = samCachePath(hash, concept);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));

  appendLedger({
    ts: new Date().toISOString(),
    model: SAM_MODEL,
    hash,
    concept,
    frames: billableFrames(clipMeta.frameCount),
    estUSD: estimateCostUSD(clipMeta.frameCount),
  });

  return out;
}
