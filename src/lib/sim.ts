/**
 * I-95 sim math: polylines, car motion, slow zones, ETA projection, demo script.
 * Browser-safe: no node imports, no API access. Pure functions only, so the
 * same code drives the page and headless checks.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export const MPH_TO_MPS = 0.44704;
export const METERS_PER_MILE = 1609.344;
/** Sim clock starts at 9:00 AM. */
export const SIM_START_MINUTES = 9 * 60;

/** Deterministic RNG so every run lays out the same traffic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Google encoded-polyline decode. */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  while (i < encoded.length) {
    let b = 0;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    b = 0;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const r = 6371e3;
  const t = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * t) / 2) ** 2 +
    Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(((b.lng - a.lng) * t) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

export interface RouteGeom {
  points: LatLng[];
  /** Cumulative arclength in meters at each point. */
  cum: number[];
  length: number;
}

export function buildRouteGeom(points: LatLng[]): RouteGeom {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  return { points, cum, length: cum[cum.length - 1] ?? 0 };
}

/** Position s meters along the route (clamped), interpolated. */
export function pointAt(geom: RouteGeom, s: number): LatLng {
  const { points, cum, length } = geom;
  if (points.length === 0) return { lat: 0, lng: 0 };
  const c = Math.min(length, Math.max(0, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < c) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const segLen = cum[i] - cum[i - 1];
  const t = segLen > 0 ? (c - cum[i - 1]) / segLen : 0;
  return {
    lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * t,
    lng: points[i - 1].lng + (points[i].lng - points[i - 1].lng) * t,
  };
}

/** Nearest route point to p (segment projection, equirectangular approx). */
export function nearestOnRoute(geom: RouteGeom, p: LatLng): { s: number; point: LatLng } {
  const { points, cum } = geom;
  const kx = Math.cos((p.lat * Math.PI) / 180);
  let best = { s: 0, point: points[0] ?? { lat: 0, lng: 0 }, d2: Infinity };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const ax = a.lng * kx;
    const ay = a.lat;
    const bx = b.lng * kx;
    const by = b.lat;
    const px = p.lng * kx;
    const py = p.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qx = ax + dx * t;
    const qy = ay + dy * t;
    const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
    if (d2 < best.d2) {
      best = {
        s: cum[i - 1] + Math.sqrt(len2) * t * 111320,
        point: { lat: qy, lng: qx / kx },
        d2,
      };
    }
  }
  return { s: best.s, point: best.point };
}

export interface SimCar {
  id: number;
  /** +1 southbound (s grows), -1 northbound (s shrinks). */
  dir: 1 | -1;
  s: number;
  baseMps: number;
}

/** 24 southbound + 6 northbound, spread along the route, 55–65 mph. */
export function createCars(seed: number, length: number): SimCar[] {
  const rng = mulberry32(seed);
  const cars: SimCar[] = [];
  for (let i = 0; i < 24; i++) {
    cars.push({
      id: i,
      dir: 1,
      s: (((i + rng()) / 24) * length) % length,
      baseMps: (55 + rng() * 10) * MPH_TO_MPS,
    });
  }
  for (let i = 0; i < 6; i++) {
    cars.push({
      id: 24 + i,
      dir: -1,
      s: (((i + rng()) / 6) * length) % length,
      baseMps: (55 + rng() * 10) * MPH_TO_MPS,
    });
  }
  return cars;
}

export interface SlowZone {
  /** Upstream edge (smaller s) and incident edge, meters. */
  s0: number;
  s1: number;
  mps: number;
}

/** Capped speed by incident stage; null means normal speed. */
export const STAGE_SPEED_MPH: Record<string, number | null> = {
  no_responders: 10,
  responders_on_scene: 15,
  tow_in_progress: 25,
  clearing: 40,
  cleared: null,
  not_applicable: null,
};

export function stageSpeedMps(stage: string): number | null {
  return STAGE_SPEED_MPH[stage] ?? null;
}

export function speedInZones(baseMps: number, s: number, zones: SlowZone[]): number {
  let v = baseMps;
  for (const z of zones) {
    if (s >= z.s0 && s <= z.s1 && z.mps < v) v = z.mps;
  }
  return v;
}

/** Advance one car by dt sim-seconds. Background traffic wraps around. */
export function stepCar(car: SimCar, dtSim: number, zones: SlowZone[], length: number): void {
  const v = car.dir === 1 ? speedInZones(car.baseMps, car.s, zones) : car.baseMps;
  car.s += car.dir * v * dtSim;
  if (car.s >= length) car.s -= length;
  if (car.s < 0) car.s += length;
}

/**
 * Project your car's remaining time by walking 100 m chunks to the end
 * through today's zones. Recomputed live, so ETA reacts to slowdowns.
 */
export function projectEta(
  s: number,
  zones: SlowZone[],
  baseMps: number,
  length: number,
): { seconds: number; milesLeft: number } {
  let t = 0;
  let x = Math.min(s, length);
  while (x < length) {
    const chunk = Math.min(100, length - x);
    const v = speedInZones(baseMps, x + chunk / 2, zones);
    t += chunk / Math.max(v, 1);
    x += chunk;
  }
  return { seconds: t, milesLeft: Math.max(0, (length - s) / METERS_PER_MILE) };
}

/** I-95 Exit 27 area, Bridgeport — demo incident anchor (snapped to MAIN). */
export const EXIT27: LatLng = { lat: 41.1727, lng: -73.183 };

export interface DemoEvent {
  atMin: number;
  kind: 'report' | 'followup';
  clip: string;
  /** Step 5: 2nd and 4th reports come from northbound (oncoming) cars. */
  from: 'same' | 'oncoming';
}

export const DEMO_EVENTS: DemoEvent[] = [
  { atMin: 0, kind: 'report', clip: 'crash-1', from: 'same' },
  { atMin: 12, kind: 'followup', clip: 'car-tow-ambulance-police-1', from: 'oncoming' },
  { atMin: 25, kind: 'followup', clip: 'car-police-tow-1', from: 'same' },
  { atMin: 40, kind: 'followup', clip: 'dash-cam-car-1', from: 'oncoming' },
];

/** "t+MM:SS" for the sim clock. */
export function formatElapsed(simSeconds: number): string {
  const m = Math.floor(simSeconds / 60);
  const s = Math.floor(simSeconds % 60);
  return `t+${m}:${String(s).padStart(2, '0')}`;
}

/** Wall-clock ETA from sim start + elapsed + remaining. */
export function formatEta(simElapsedSeconds: number, remainingSeconds: number): string {
  const totalMin = SIM_START_MINUTES + Math.round((simElapsedSeconds + remainingSeconds) / 60);
  const h24 = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}
