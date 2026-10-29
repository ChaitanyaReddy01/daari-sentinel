import type { SamCachedResult } from '@/lib/sam';

/** Concepts tracked on /try stills (subset of the lab list). */
export const TRY_DETECT_CONCEPTS = [
  'car',
  'truck',
  'police car',
  'ambulance',
  'fire truck',
  'tow truck',
  'person',
  'safety vest',
];

export interface TryBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  id: string;
  c: number | null;
}

export interface TryDetectStill {
  index: number;
  seconds: number;
  width: number;
  height: number;
  counts: Record<string, number>;
  boxes: Record<string, TryBox[]>;
}

export interface TryDetectData {
  stills: TryDetectStill[];
}

/**
 * Synthesize per-concept SAM results from still detections so the existing
 * buildChecks works unchanged. Boxes carry still-frame numbers mapped onto
 * a 10 fps timeline (frame = round(seconds * 10)).
 */
export function trySamRecord(data: TryDetectData): Record<string, SamCachedResult | null> {
  const sam: Record<string, SamCachedResult | null> = {};
  const width = Math.max(1, ...data.stills.map((s) => s.width));
  const height = Math.max(1, ...data.stills.map((s) => s.height));
  for (const concept of TRY_DETECT_CONCEPTS) {
    const boxes = data.stills.flatMap((s) =>
      (s.boxes[concept] ?? []).map((b, k) => ({
        frame: Math.round(s.seconds * 10),
        id: `${s.index}:${b.id || k}`,
        x1: b.x1,
        y1: b.y1,
        x2: b.x2,
        y2: b.y2,
        c: b.c,
      })),
    );
    const frames = boxes.map((b) => b.frame);
    const objects = Math.max(0, ...data.stills.map((s) => s.counts[concept] ?? 0));
    const confs = boxes.map((b) => b.c).filter((c): c is number => typeof c === 'number');
    sam[concept] = {
      summary: {
        concept,
        objects,
        firstFrame: frames.length > 0 ? Math.min(...frames) : null,
        lastFrame: frames.length > 0 ? Math.max(...frames) : null,
        maxConfidence: confs.length > 0 ? Math.max(...confs) : null,
      },
      boxes,
      width,
      height,
      fps: 10,
    };
  }
  return sam;
}

/** Display counts ("0".."15", "16+") from still maxima, agent format. */
export function trySamCounts(data: TryDetectData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const concept of TRY_DETECT_CONCEPTS) {
    const n = Math.max(0, ...data.stills.map((s) => s.counts[concept] ?? 0));
    out[concept] = n >= 16 ? '16+' : String(n);
  }
  return out;
}

/** Server-canonical SAM hints line for the verdict prompt. */
export function tryHintsText(data: TryDetectData): string {
  const parts: string[] = [];
  for (const concept of TRY_DETECT_CONCEPTS) {
    const n = Math.max(0, ...data.stills.map((s) => s.counts[concept] ?? 0));
    if (n > 0) parts.push(`${n} ${concept}${n === 1 ? '' : 's'} (max over 4 stills)`);
  }
  if (parts.length === 0) return 'Object tracker found nothing on the 4 stills.';
  return `Object tracker found: ${parts.join(', ')}.`;
}
