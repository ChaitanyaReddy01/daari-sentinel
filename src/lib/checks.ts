import type { SamCachedResult } from './sam';
import type { Verdict } from './verdict';

/**
 * Evidence cross-check: every verdict claim is either backed by SAM 3.1
 * detections or flagged. Key-free: works purely from cached data.
 */

export interface VerdictCheck {
  claim: string;
  status: 'supported' | 'unverified' | 'conflict';
  detail: string;
}

const RESPONDERS = [
  { key: 'police', concept: 'police car', label: 'Police' },
  { key: 'ambulance', concept: 'ambulance', label: 'Ambulance' },
  { key: 'fire', concept: 'fire truck', label: 'Fire crew' },
  { key: 'towTruck', concept: 'tow truck', label: 'Tow truck' },
] as const;

function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildChecks({
  verdict,
  sam,
  fps,
}: {
  verdict: Verdict;
  sam: Record<string, SamCachedResult | null>;
  fps: number;
}): VerdictCheck[] {
  const checks: VerdictCheck[] = [];

  for (const { key, concept, label } of RESPONDERS) {
    const claimed = verdict.responders[key];
    const cached = sam[concept] ?? null;
    const objects = cached?.summary.objects;
    if (claimed) {
      if (cached === null || objects === undefined) {
        checks.push({
          claim: `${label} on scene`,
          status: 'unverified',
          detail: `Claimed, but no SAM data for '${concept}' (run Analyze first).`,
        });
      } else if (objects > 0) {
        checks.push({
          claim: `${label} on scene`,
          status: 'supported',
          detail: `SAM tracked ${pluralize(objects, concept, `${concept}s`)}.`,
        });
      } else {
        checks.push({
          claim: `${label} on scene`,
          status: 'unverified',
          detail: `SAM found no '${concept}' in this clip.`,
        });
      }
    } else if (cached !== null && (objects ?? 0) > 0) {
      checks.push({
        claim: `${label} on scene`,
        status: 'unverified',
        detail: `Verdict reports none, but SAM tracked ${pluralize(objects ?? 0, concept, `${concept}s`)} — worth a look.`,
      });
    } else {
      checks.push({
        claim: `${label} on scene`,
        status: 'supported',
        detail:
          cached === null
            ? 'Not claimed; no SAM data to cross-check.'
            : 'Not claimed; SAM agrees (none tracked).',
      });
    }
  }

  if (verdict.vehiclesInvolved !== null) {
    const n = verdict.vehiclesInvolved;
    const label = pluralize(n, 'vehicle', 'vehicles');
    if (n === 0) {
      checks.push({
        claim: `${label} involved`,
        status: 'supported',
        detail: 'Claim is 0 vehicles involved — nothing to match.',
      });
    } else {
      const car = sam['car'] ?? null;
      const truck = sam['truck'] ?? null;
      if (car === null || truck === null) {
        checks.push({
          claim: `${label} involved`,
          status: 'unverified',
          detail: "Missing SAM data for 'car'/'truck' counts (run Analyze first).",
        });
      } else if (verdict.evidence.length === 0) {
        checks.push({
          claim: `${label} involved`,
          status: 'unverified',
          detail: 'No evidence timestamps to compare against.',
        });
      } else {
        const f = fps > 0 ? fps : 10;
        const boxes = [
          ...car.boxes.map((b) => ({ frame: b.frame, id: `car:${b.id}` })),
          ...truck.boxes.map((b) => ({ frame: b.frame, id: `truck:${b.id}` })),
        ];
        let best: { second: number; count: number } | null = null;
        for (const e of verdict.evidence) {
          const lo = e.second * f - f;
          const hi = e.second * f + f;
          const ids = new Set(
            boxes.filter((b) => b.frame >= lo && b.frame <= hi).map((b) => b.id),
          );
          if (!best || ids.size > best.count) best = { second: e.second, count: ids.size };
        }
        checks.push(
          best !== null && best.count >= n
            ? {
                claim: `${label} involved`,
                status: 'supported',
                detail: `SAM tracked ${best.count} cars+trucks within ±1s of second ${best.second} (claim: ${n}).`,
              }
            : {
                claim: `${label} involved`,
                status: 'unverified',
                detail: `SAM tracked at most ${best?.count ?? 0} cars+trucks near any evidence second (claim: ${n}).`,
              },
        );
      }
    }
  }

  if (verdict.incident) {
    const person = sam['person'] ?? null;
    if (person === null) {
      checks.push({
        claim: 'People on scene',
        status: 'unverified',
        detail: "No SAM data for 'person' (run Analyze first).",
      });
    } else if (verdict.evidence.length === 0) {
      checks.push({
        claim: 'People on scene',
        status: 'unverified',
        detail: 'No evidence timestamps to compare against.',
      });
    } else {
      const window = fps > 0 ? fps : 10;
      const nearSecond = verdict.evidence.find((e) =>
        person.boxes.some((b) => Math.abs(b.frame - e.second * fps) <= window),
      );
      checks.push(
        nearSecond !== undefined
          ? {
              claim: 'People on scene',
              status: 'supported',
              detail: `SAM tracked a person near second ${nearSecond.second} ("${nearSecond.what}").`,
            }
          : {
              claim: 'People on scene',
              status: 'unverified',
              detail: 'No persons tracked near the evidence timestamps.',
            },
      );
    }
  }

  if (!verdict.incident && verdict.severity !== null) {
    checks.push({
      claim: 'No incident',
      status: 'conflict',
      detail: `Incident is false but severity is '${verdict.severity}'.`,
    });
  }

  return checks;
}
