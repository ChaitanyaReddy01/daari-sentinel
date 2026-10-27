import {
  MPH_TO_MPS,
  haversineMeters,
  pointAt,
  speedInZones,
  type LatLng,
  type RouteGeom,
  type SlowZone,
} from '@/lib/sim';

/**
 * Driver-experience math (warnings, options, reroutes). Browser-safe: no node
 * imports. Builds on the route geometry in @/lib/sim, which stays untouched.
 */

/** Minimum distance from p to any route segment, in meters. */
export function minDistanceToRoute(geom: RouteGeom, p: LatLng): number {
  const { points } = geom;
  if (points.length === 0) return Infinity;
  const kx = Math.cos((p.lat * Math.PI) / 180);
  let best = Infinity;
  const consider = (a: LatLng, b: LatLng) => {
    const ax = a.lng * kx;
    const ay = a.lat;
    const bx = b.lng * kx;
    const by = b.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0
        ? Math.min(1, Math.max(0, ((p.lng * kx - ax) * dx + (p.lat - ay) * dy) / len2))
        : 0;
    const q: LatLng = { lat: ay + dy * t, lng: (ax + dx * t) / kx };
    const d = haversineMeters(p, q);
    if (d < best) best = d;
  };
  for (let i = 1; i < points.length; i++) consider(points[i - 1], points[i]);
  if (points.length === 1) best = haversineMeters(p, points[0]);
  return best;
}

export interface Divergence {
  /** Arclength on your route where the alternative leaves it. */
  s: number;
  /** Arclength on the alternative at the same point. */
  altS: number;
}

/**
 * Last point on your route before beforeS that stays within tolM of the
 * alternative route: the last place you can still switch.
 */
export function findDivergence(
  mainGeom: RouteGeom,
  altPoints: LatLng[],
  beforeS: number,
  tolM: number,
): Divergence | null {
  if (altPoints.length === 0) return null;
  const altGeom = { points: altPoints, cum: [] as number[], length: 0 };
  // Arclength table for the alternative (local: no import cycle).
  const cum: number[] = [0];
  for (let i = 1; i < altPoints.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(altPoints[i - 1], altPoints[i]));
  }
  altGeom.cum = cum;
  altGeom.length = cum[cum.length - 1] ?? 0;

  let best: Divergence | null = null;
  const { points, cum: mainCum } = mainGeom;
  for (let i = 0; i < points.length; i++) {
    const s = mainCum[i];
    if (s >= beforeS) break;
    if (i > 0 && mainCum[i] - mainCum[i - 1] === 0) continue;
    if (minDistanceToRoute(altGeom, points[i]) > tolM) continue;
    // Arclength on the alternative nearest to this shared point.
    let altS = 0;
    let bestD = Infinity;
    for (let j = 0; j < altPoints.length; j++) {
      const d = haversineMeters(points[i], altPoints[j]);
      if (d < bestD) {
        bestD = d;
        altS = cum[j];
      }
    }
    best = { s, altS };
  }
  return best;
}

/** Sim seconds to drive from s to targetS through today's zones. */
export function projectToS(s: number, targetS: number, zones: SlowZone[], baseMps: number): number {
  let t = 0;
  let x = Math.min(s, targetS);
  while (x < targetS) {
    const chunk = Math.min(100, targetS - x);
    t += chunk / Math.max(speedInZones(baseMps, x + chunk / 2, zones), 1);
    x += chunk;
  }
  return t;
}

/**
 * Sim seconds to drive from s to the route end if the zones clear
 * recoveryInSeconds from now, then traffic flows free.
 */
export function projectEtaWithRecovery(
  s: number,
  zones: SlowZone[],
  baseMps: number,
  length: number,
  recoveryInSeconds: number,
): number {
  let t = 0;
  let x = Math.min(s, length);
  while (x < length) {
    const chunk = Math.min(100, length - x);
    const v = t < recoveryInSeconds ? speedInZones(baseMps, x + chunk / 2, zones) : baseMps;
    t += chunk / Math.max(v, 1);
    x += chunk;
  }
  return t;
}

/** Slice of route points between s0 and s1 (endpoints interpolated). */
export function subPath(geom: RouteGeom, s0: number, s1: number): LatLng[] {
  const { points, cum } = geom;
  const out: LatLng[] = [pointAt(geom, s0)];
  for (let i = 0; i < points.length; i++) {
    if (cum[i] > s0 && cum[i] < s1) out.push(points[i]);
  }
  out.push(pointAt(geom, s1));
  return out;
}

/**
 * Two candidate waypoints distanceM off-route, perpendicular to the route at
 * incidentS. First candidate is the side farther from the route corridor.
 */
export function offRouteCandidates(
  geom: RouteGeom,
  incidentS: number,
  distanceM: number,
): [LatLng, LatLng] {
  const center = pointAt(geom, incidentS);
  const ahead = pointAt(geom, Math.min(geom.length, incidentS + 200));
  const behind = pointAt(geom, Math.max(0, incidentS - 200));
  const kx = Math.cos((center.lat * Math.PI) / 180);
  let dx = (ahead.lng - behind.lng) * kx;
  let dy = ahead.lat - behind.lat;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  // Perpendicular (-dy, dx), scaled to distanceM (degrees latitude approx).
  const scale = distanceM / 111320;
  const a: LatLng = { lat: center.lat + dx * scale, lng: center.lng - (dy * scale) / kx };
  const b: LatLng = { lat: center.lat - dx * scale, lng: center.lng + (dy * scale) / kx };
  return minDistanceToRoute(geom, a) >= minDistanceToRoute(geom, b) ? [a, b] : [b, a];
}

export function mph(mps: number): number {
  return mps / MPH_TO_MPS;
}

/** Short two-tone alert. Silent when audio is unavailable or blocked. */
export function beep(): void {
  try {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t0 = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.18);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 700);
  } catch {
    // Audio unavailable: stay silent.
  }
}

/** Strip HTML tags from a navigation instruction. */
export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

/** Speak one short alert. Silent when speech is unavailable. */
export function speak(text: string): void {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Speech unavailable: stay silent.
  }
}

/* ---- P4b: realistic jam-delay model (minutes) ---- */

/** How much of the remaining closure you sit through, by lanes blocked. */
export function blockageFactor(lanes: string): number {
  switch (lanes) {
    case 'all':
      return 1.0;
    case 'two':
      return 0.8;
    case 'one':
      return 0.5;
    case 'shoulder':
      return 0.2;
    case 'none':
      return 0;
    default:
      return 0.6; // unknown
  }
}

/** Leftover queue once the road reopens: 2-5 min by incident age. */
export function residualQueueMin(ageMin: number): number {
  return Math.min(5, 2 + Math.max(0, ageMin) / 20);
}

/** Fixed queue added to a wait-at-the-incident delay (minutes). */
export const WAIT_RESIDUAL_MIN = 3;

/**
 * STAY delay for one clearance end: the wait at the incident, scaled by
 * blockage, plus a residual queue. Past clearance, residual only.
 */
export function stayDelayMin(
  tMin: number,
  cMin: number,
  cHigh: number,
  lanes: string,
  ageMin: number,
): number {
  if (tMin >= cHigh) return residualQueueMin(ageMin);
  return Math.max(0, cMin - tMin) * blockageFactor(lanes) + WAIT_RESIDUAL_MIN;
}

export interface StayDelayRange {
  lo: number;
  mid: number;
  hi: number;
}

/** STAY delay range from the clearance ends, midpoint as headline. */
export function stayDelayRange(
  tMin: number,
  cLo: number,
  cMid: number,
  cHigh: number,
  lanes: string,
  ageMin: number,
): StayDelayRange {
  return {
    lo: stayDelayMin(tMin, cLo, cHigh, lanes, ageMin),
    mid: stayDelayMin(tMin, cMid, cHigh, lanes, ageMin),
    hi: stayDelayMin(tMin, cHigh, cHigh, lanes, ageMin),
  };
}

/** REROUTE extra minutes vs the main route. Never negative. */
export function rerouteDelayMin(
  toDivergeSec: number,
  altRemainSec: number,
  mainRemainSec: number,
): number {
  return Math.max(0, (toDivergeSec + altRemainSec - mainRemainSec) / 60);
}

/** Remaining seconds from a Routes total duration, prorated by distance. */
export function routesRemainSec(totalDurationSec: number, totalLengthM: number, s: number): number {
  if (totalLengthM <= 0 || totalDurationSec <= 0) return 0;
  const frac = Math.min(1, Math.max(0, s / totalLengthM));
  return Math.max(0, totalDurationSec * (1 - frac));
}

/* ---- P4b: exit-based decide-by and route names ---- */

export interface StepLike {
  distanceMeters: number;
  instruction: string | null;
}

const ROAD_RE =
  /\b([A-Z]{2}-\d+[A-Z]?|I-\d+|US-\d+|Route \d+|[A-Z][\w.'-]* (?:Pkwy|Parkway|Tpke|Turnpike|Expwy|Expressway|Hwy))\b/;

/** "Take exit 26 toward US-1" -> "Exit 26 (US-1)". Null when nothing found. */
export function parseDecideByLabel(instruction: string): string | null {
  const text = stripTags(instruction);
  const exit = /\bexit\s+(\d+[A-Z]?)/i.exec(text)?.[1] ?? null;
  const road = ROAD_RE.exec(text)?.[1] ?? null;
  if (exit && road) return `Exit ${exit} (${road})`;
  if (exit) return `Exit ${exit}`;
  return road;
}

/**
 * Decide-by label from the alternative route: scan forward from the step
 * containing the divergence point for the first exit/road instruction.
 */
export function decideByLabel(steps: StepLike[], altS: number): string | null {
  let cum = 0;
  let started = false;
  for (const st of steps) {
    const start = cum;
    cum += st.distanceMeters;
    if (!started && altS >= start && altS < cum) started = true;
    if (!started && start >= altS - 1) started = true;
    if (!started || !st.instruction) continue;
    const label = parseDecideByLabel(st.instruction);
    if (label) return label;
  }
  return null;
}

/** Road token carrying the most step distance, e.g. "I-95". */
export function longestRoad(steps: StepLike[]): string | null {
  const totals = new Map<string, number>();
  for (const st of steps) {
    if (!st.instruction) continue;
    const m = ROAD_RE.exec(stripTags(st.instruction));
    if (!m) continue;
    totals.set(m[1], (totals.get(m[1]) ?? 0) + st.distanceMeters);
  }
  let best: string | null = null;
  let bestM = 0;
  totals.forEach((m, road) => {
    if (m > bestM) {
      bestM = m;
      best = road;
    }
  });
  return best;
}

/** Display name: Routes description, else the longest road. */
export function routeName(description: string | null | undefined, steps: StepLike[]): string {
  if (description && description.trim()) return description.trim();
  return longestRoad(steps) ?? 'this route';
}
