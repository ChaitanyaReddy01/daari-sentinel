import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertLiveCalls, readSnapshotJson } from './snapshot';

/**
 * Server-only trip routing: origin → destination with alternatives and step
 * instructions. Never import from client components.
 */

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.description',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.navigationInstruction',
].join(',');
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache', 'routes');
const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');

export interface TripStep {
  distanceMeters: number;
  instruction: string | null;
  /** Step drive time from the Routes API (staticDuration), seconds. */
  durationSeconds: number;
}

export interface TripRoute {
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
  description: string | null;
  steps: TripStep[];
}

export type TripPoint =
  | { lat: number; lng: number }
  | { address: string }
  | { placeId: string };

export interface TripRequest {
  origin: TripPoint;
  destination: TripPoint;
  via?: { lat: number; lng: number };
}

function serverKey(): string {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_SERVER_KEY is not set.');
  return key;
}

function appendRoutesLedger(): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(
    LEDGER_PATH,
    JSON.stringify({
      ts: new Date().toISOString(),
      model: 'routes-api',
      route: 'trip',
      kind: 'routes',
      estUSD: 0,
    }) + '\n',
  );
}

function waypointBody(p: TripPoint): Record<string, unknown> {
  if ('placeId' in p) return { placeId: p.placeId };
  if ('address' in p) return { address: p.address };
  return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
}

/** Route + alternatives for a trip, cached by origin+destination (+via). */
export async function getTrip(req: TripRequest): Promise<{ routes: TripRoute[] }> {
  const origin = waypointBody(req.origin);
  const destination = waypointBody(req.destination);
  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify({ origin, destination, via: req.via ?? null }))
    .digest('hex');
  // trip3-: Step 5 added legs.steps.staticDuration; trip2- entries lack it.
  const cachePath = path.join(CACHE_DIR, `trip3-${cacheKey}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { routes: TripRoute[] };
    if (parsed && Array.isArray(parsed.routes) && parsed.routes.length > 0) {
      if (parsed.routes.every((r) => r.steps.every((s) => typeof s.durationSeconds === 'number'))) {
        return parsed;
      }
    }
  } catch {
    // Cache miss: migrate or fetch below.
  }
  // Migrate trip2- entries by prorating the total duration over step
  // distances, so existing caches keep working without a refetch.
  try {
    const legacy = JSON.parse(
      fs.readFileSync(path.join(CACHE_DIR, `trip2-${cacheKey}.json`), 'utf8'),
    ) as { routes: TripRoute[] };
    if (legacy && Array.isArray(legacy.routes) && legacy.routes.length > 0) {
      for (const r of legacy.routes) {
        const totalDist = r.steps.reduce((a, s) => a + (s.distanceMeters || 0), 0);
        let assigned = 0;
        r.steps.forEach((s, i) => {
          if (typeof s.durationSeconds === 'number' && s.durationSeconds > 0) {
            assigned += s.durationSeconds;
            return;
          }
          if (i < r.steps.length - 1 && totalDist > 0 && r.durationSeconds > 0) {
            s.durationSeconds = Math.max(
              1,
              Math.round((r.durationSeconds * (s.distanceMeters || 0)) / totalDist),
            );
            assigned += s.durationSeconds;
          } else {
            s.durationSeconds = Math.max(0, r.durationSeconds - assigned);
          }
        });
      }
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(legacy));
      return legacy;
    }
  } catch {
    // No legacy entry: snapshot, then fetch below.
  }
  const snap = readSnapshotJson<{ routes: TripRoute[] }>(
    path.join('routes', `trip3-${cacheKey}.json`),
  );
  if (
    snap &&
    Array.isArray(snap.routes) &&
    snap.routes.length > 0 &&
    snap.routes.every((r) => r.steps.every((s) => typeof s.durationSeconds === 'number'))
  ) {
    return snap;
  }

  assertLiveCalls(`Routes API trip ${cacheKey.slice(0, 12)}…`);
  const body: Record<string, unknown> = {
    origin,
    destination,
    travelMode: 'DRIVE',
    computeAlternativeRoutes: !req.via,
  };
  if (req.via) {
    body.intermediates = [
      {
        via: true,
        location: { latLng: { latitude: req.via.lat, longitude: req.via.lng } },
      },
    ];
  }
  let res: Response;
  try {
    res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': serverKey(),
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Routes API trip request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Routes API trip failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    routes?: Array<{
      distanceMeters?: number;
      duration?: string;
      description?: string;
      polyline?: { encodedPolyline?: string };
      legs?: Array<{
        steps?: Array<{
          distanceMeters?: number;
          staticDuration?: string;
          navigationInstruction?: { instructions?: string };
        }>;
      }>;
    }>;
  };
  if (!data.routes || data.routes.length === 0) {
    throw new Error('Routes API trip returned no routes.');
  }
  const routes: TripRoute[] = [];
  for (const r of data.routes) {
    const poly = r.polyline?.encodedPolyline;
    if (typeof poly !== 'string' || !poly || typeof r.distanceMeters !== 'number') continue;
    const seconds = /^(-?\d+)s$/.exec(r.duration ?? '')?.[1];
    const steps: TripStep[] = [];
    for (const leg of r.legs ?? []) {
      for (const s of leg.steps ?? []) {
        const stepSeconds = /^(-?\d+)s$/.exec(s.staticDuration ?? '')?.[1];
        steps.push({
          distanceMeters: typeof s.distanceMeters === 'number' ? s.distanceMeters : 0,
          instruction:
            typeof s.navigationInstruction?.instructions === 'string'
              ? s.navigationInstruction.instructions
              : null,
          durationSeconds: stepSeconds ? parseInt(stepSeconds, 10) : 0,
        });
      }
    }
    routes.push({
      encodedPolyline: poly,
      distanceMeters: r.distanceMeters,
      durationSeconds: seconds ? parseInt(seconds, 10) : 0,
      description: typeof r.description === 'string' ? r.description : null,
      steps,
    });
  }
  if (routes.length === 0) {
    throw new Error('Routes API trip returned no usable routes.');
  }
  const out = { routes };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(out));
  appendRoutesLedger();
  return out;
}
