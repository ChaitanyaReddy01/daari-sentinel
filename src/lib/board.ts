/**
 * Step 8f community incident board (server-only). Confirmed /try incidents
 * are posted with a road-snapped location; every visitor's /sim polls the
 * board and warns drivers whose route passes an incident ahead.
 *
 * Storage is Upstash Redis: one JSON key per incident (TTL = expiresAt)
 * plus a zset index scored by expiry. Nothing stored here identifies the
 * poster — no IPs, no tryIds, blurred stills only.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Redis } from '@upstash/redis';

import type { StoredAssessment } from './agent';
import type { AgentAssessment, AgentReportInput } from './agent-guard';
import { minDistanceToRoute, routeName } from '@/app/sim/drive';
import {
  buildRouteGeom,
  decodePolyline,
  haversineMeters,
  type LatLng,
  type RouteGeom,
} from './sim';
import type { TripRoute } from './trip';
import type { Verdict } from './verdict';

/** Slim verdict subset stored per board incident (never the full verdict). */
export interface BoardVerdict {
  type: string;
  stage: string;
  summary: string;
  responders: Verdict['responders'];
  lanesBlocked: string;
}

export interface BoardStill {
  seconds: number;
  jpeg: string;
}

export interface BoardIncident {
  id: string;
  lat: number;
  lng: number;
  road: string;
  /** Corridor travel bearing (deg) of the snapped road, null when unknown. */
  bearingDeg: number | null;
  verdict: BoardVerdict;
  assessment: StoredAssessment;
  /** Full report history for follow-up agent context (never served). */
  reports: AgentReportInput[];
  stills: BoardStill[];
  reportCount: number;
  clearCount: number;
  stage: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  source: 'community';
}

/** Public projection: everything GET /api/board returns. No internals. */
export interface BoardPublic extends Omit<BoardIncident, 'reports' | 'assessment'> {
  assessment: Pick<StoredAssessment, 'assessment' | 'source' | 'notes'>;
}

/** CT–NYC corridor bounds for community posts. */
export const BOARD_BBOX = {
  minLat: 40.45,
  maxLat: 41.8,
  minLng: -74.35,
  maxLng: -71.75,
};

export function inCorridor(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= BOARD_BBOX.minLat &&
    lat <= BOARD_BBOX.maxLat &&
    lng >= BOARD_BBOX.minLng &&
    lng <= BOARD_BBOX.maxLng
  );
}

/** Post lifetime: 2 h default, tests may shorten (never extend). */
export const BOARD_TTL_DEFAULT_SEC = 2 * 3600;
export const BOARD_TTL_MIN_SEC = 30;
export const BOARD_TTL_MAX_SEC = 2 * 3600;
/** Follow-up / clear-evidence attach radius. */
export const BOARD_ATTACH_METERS = 500;
/** Road-snap radius for posted locations. */
export const BOARD_SNAP_METERS = 300;
/** Max posts per IP per ET day (owner exempt). */
export const BOARD_MAX_PER_IP_DAY = 2;
/** Max blurred stills stored per incident. */
export const BOARD_MAX_STILLS = 4;
/** Max decoded bytes per posted still (80 KB). */
export const BOARD_STILL_MAX_BYTES = 80 * 1024;
/** Clear-evidence posts that clear an incident. */
export const BOARD_CLEAR_VOTES = 2;

const KEY_PREFIX = 'daari:board:v1:';
const IDX_KEY = `${KEY_PREFIX}idx`;

function redis(): Redis {
  return Redis.fromEnv();
}

function boardKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

export function boardPostCountKey(ip: string, day: string): string {
  return `${KEY_PREFIX}ip:${ip}:${day}`;
}

// ---- road snapping (committed Routes snapshot, $0) ----

interface SnapRoute {
  geom: RouteGeom;
  description: string | null;
  steps: TripRoute['steps'];
  direction: 'sb' | 'nb';
}

let snapRoutes: SnapRoute[] | null = null;

function loadSnapRoutes(): SnapRoute[] {
  if (snapRoutes) return snapRoutes;
  const file = path.join(process.cwd(), 'data', 'snapshot', 'network', 'trips.json');
  const trips = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    direction: 'sb' | 'nb';
    routes: TripRoute[];
  }[];
  snapRoutes = trips.flatMap((t) =>
    t.routes.map((r) => ({
      geom: buildRouteGeom(decodePolyline(r.encodedPolyline)),
      description: r.description,
      steps: r.steps,
      direction: t.direction,
    })),
  );
  return snapRoutes;
}

export interface SnapHit {
  lat: number;
  lng: number;
  road: string;
  distM: number;
  /** Corridor (south/westbound) travel bearing, or null when unknown. */
  bearingDeg: number | null;
}

/** Walk segments for the nearest projection + that segment's bearing. */
function nearestSeg(
  pts: LatLng[],
  lat: number,
  lng: number,
): { distM: number; point: LatLng; bearingDeg: number } {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  let distM = Infinity;
  let point: LatLng = pts[0];
  let bearingDeg = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const ax = (a.lng - lng) * kx;
    const ay = (a.lat - lat) * ky;
    const dx = (b.lng - a.lng) * kx;
    const dy = (b.lat - a.lat) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < distM) {
      distM = d;
      point = { lat: lat + (ay + t * dy) / ky, lng: lng + (ax + t * dx) / kx };
      bearingDeg = (Math.atan2(dx, dy) * 180) / Math.PI;
      if (bearingDeg < 0) bearingDeg += 360;
    }
  }
  return { distM, point, bearingDeg };
}

/**
 * Snap a point to the nearest snapshot route (either direction) within
 * 300 m. The bearing comes from the nearest south/westbound route: posts
 * carry no travel direction, so community incidents warn same-direction
 * corridor drivers and stay silent for oncoming traffic.
 */
export function snapToRoad(lat: number, lng: number): SnapHit | null {
  const p: LatLng = { lat, lng };
  let best: { route: SnapRoute; distM: number } | null = null;
  let bestSb: { route: SnapRoute; distM: number } | null = null;
  for (const route of loadSnapRoutes()) {
    const d = minDistanceToRoute(route.geom, p);
    if (!best || d < best.distM) best = { route, distM: d };
    if (route.direction === 'sb' && (!bestSb || d < bestSb.distM)) {
      bestSb = { route, distM: d };
    }
  }
  if (!best || best.distM > BOARD_SNAP_METERS) return null;
  const proj = nearestSeg(best.route.geom.points, lat, lng);
  const sbProj =
    bestSb && bestSb.distM <= 2 * BOARD_SNAP_METERS
      ? nearestSeg(bestSb.route.geom.points, lat, lng)
      : null;
  return {
    lat: proj.point.lat,
    lng: proj.point.lng,
    road: routeName(best.route.description, best.route.steps),
    distM: best.distM,
    bearingDeg: sbProj ? sbProj.bearingDeg : null,
  };
}

// ---- store ----

function toPublic(inc: BoardIncident): BoardPublic {
  return {
    id: inc.id,
    lat: inc.lat,
    lng: inc.lng,
    road: inc.road,
    bearingDeg: inc.bearingDeg,
    verdict: inc.verdict,
    assessment: {
      assessment: inc.assessment.assessment,
      source: inc.assessment.source,
      notes: inc.assessment.notes,
    },
    stills: inc.stills,
    reportCount: inc.reportCount,
    clearCount: inc.clearCount,
    stage: inc.stage,
    active: inc.active,
    createdAt: inc.createdAt,
    updatedAt: inc.updatedAt,
    expiresAt: inc.expiresAt,
    source: inc.source,
  };
}

async function pruneExpired(r: Redis, nowSec: number): Promise<void> {
  await r.zremrangebyscore(IDX_KEY, 0, nowSec);
}

/** Active (unexpired) incidents, newest first, pruned as we go. */
export async function listBoard(limit = 50): Promise<BoardPublic[]> {
  const r = redis();
  const nowSec = Math.floor(Date.now() / 1000);
  await pruneExpired(r, nowSec);
  // NOTE: keep this a plain byScore range. The Upstash client silently
  // returns [] when rev/offset/count are combined with byScore, so the
  // newest-first order and limit are applied in JS instead (verified live).
  const asc = await r.zrange<string[]>(IDX_KEY, nowSec, '+inf', { byScore: true });
  const ids = asc.reverse().slice(0, limit);
  if (ids.length === 0) return [];
  // NOTE: the Upstash client auto-parses JSON values, so mget elements
  // arrive as objects, not strings. Never JSON.parse an object here: the
  // throw would misclassify a healthy entry as dead and drop it from the
  // index (this exact bug once orphaned a live entry during verification).
  const raws = (await r.mget(...ids.map(boardKey))) as unknown[];
  const out: BoardPublic[] = [];
  const dead: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const raw: unknown = Array.isArray(raws) ? raws[i] : raws;
    if (!raw) {
      dead.push(ids[i]);
      continue;
    }
    try {
      const inc = (typeof raw === 'string' ? JSON.parse(raw) : raw) as BoardIncident;
      if (!inc || inc.id !== ids[i]) {
        dead.push(ids[i]);
        continue;
      }
      out.push(toPublic(inc));
    } catch {
      dead.push(ids[i]);
    }
  }
  if (dead.length > 0) await r.zrem(IDX_KEY, ...dead);
  return out;
}

/** Nearest active incident within `meters` of a point (full record). */
export async function findActiveNear(
  lat: number,
  lng: number,
  meters: number,
): Promise<BoardIncident | null> {
  const r = redis();
  const nowSec = Math.floor(Date.now() / 1000);
  await pruneExpired(r, nowSec);
  const ids = await r.zrange<string[]>(IDX_KEY, nowSec, '+inf', { byScore: true });
  if (ids.length === 0) return null;
  const raws = (await r.mget(...ids.map(boardKey))) as unknown[];
  let best: BoardIncident | null = null;
  let bestD = meters;
  for (const raw of Array.isArray(raws) ? raws : [raws]) {
    if (!raw) continue;
    try {
      const inc = (typeof raw === 'string' ? JSON.parse(raw) : raw) as BoardIncident;
      if (!inc || !inc.active) continue;
      const d = haversineMeters({ lat, lng }, { lat: inc.lat, lng: inc.lng });
      if (d <= bestD) {
        bestD = d;
        best = inc;
      }
    } catch {
      continue;
    }
  }
  return best;
}

export async function saveBoardIncident(inc: BoardIncident): Promise<void> {
  const r = redis();
  const expSec = Math.floor(inc.expiresAt / 1000);
  await r.set(boardKey(inc.id), JSON.stringify(inc), { exat: expSec });
  await r.zadd(IDX_KEY, { score: expSec, member: inc.id });
}

export async function deleteBoardIncident(id: string): Promise<boolean> {
  const r = redis();
  const n = await r.del(boardKey(id));
  await r.zrem(IDX_KEY, id);
  return n > 0;
}

export type { AgentAssessment };
