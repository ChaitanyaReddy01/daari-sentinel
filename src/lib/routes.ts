import fs from 'node:fs';
import path from 'node:path';

import { assertLiveCalls, readSnapshotJson } from './snapshot';

/**
 * Server-only Google Routes API client (computeRoutes). Never import from
 * client components: GOOGLE_MAPS_SERVER_KEY must never reach the browser.
 */

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline';
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache', 'routes');
const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteData {
  name: string;
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
}

const ORIGIN = 'New Haven, CT';
const DESTINATION = 'Times Square, New York, NY';
// US-1 (Boston Ave corridor) in Bridgeport, CT — forces the detour off I-95.
const DETOUR_WAYPOINT: LatLng = { lat: 41.1908, lng: -73.1843 };

function serverKey(): string {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_SERVER_KEY is not set.');
  return key;
}

function cachePath(name: string): string {
  return path.join(CACHE_DIR, `${name}.json`);
}

export function readRouteCache(name: string): RouteData | null {
  let parsed: RouteData | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath(name), 'utf8')) as RouteData;
  } catch {
    parsed = readSnapshotJson<RouteData>(path.join('routes', `${name}.json`));
  }
  if (!parsed || typeof parsed.encodedPolyline !== 'string' || !parsed.encodedPolyline) {
    return null;
  }
  return parsed;
}

function appendRoutesLedger(name: string): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(
    LEDGER_PATH,
    JSON.stringify({
      ts: new Date().toISOString(),
      model: 'routes-api',
      route: name,
      kind: 'routes',
      estUSD: 0,
    }) + '\n',
  );
}

async function fetchRoute(name: 'main' | 'detour'): Promise<RouteData> {
  assertLiveCalls(`Routes API ${name} route`);
  const body: Record<string, unknown> = {
    origin: { address: ORIGIN },
    destination: { address: DESTINATION },
    travelMode: 'DRIVE',
    computeAlternativeRoutes: false,
  };
  if (name === 'detour') {
    body.intermediates = [
      {
        via: true,
        location: {
          latLng: { latitude: DETOUR_WAYPOINT.lat, longitude: DETOUR_WAYPOINT.lng },
        },
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
      `Routes API ${name} request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Routes API ${name} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    routes?: Array<{
      distanceMeters?: number;
      duration?: string;
      polyline?: { encodedPolyline?: string };
    }>;
  };
  const r = data.routes?.[0];
  const poly = r?.polyline?.encodedPolyline;
  if (!r || typeof poly !== 'string' || !poly || typeof r.distanceMeters !== 'number') {
    throw new Error(`Routes API ${name} returned no route.`);
  }
  const seconds = /^(-?\d+)s$/.exec(r.duration ?? '')?.[1];
  const out: RouteData = {
    name,
    encodedPolyline: poly,
    distanceMeters: r.distanceMeters,
    durationSeconds: seconds ? parseInt(seconds, 10) : 0,
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(name), JSON.stringify(out));
  appendRoutesLedger(name);
  return out;
}

/** Cached route, fetched once from the Routes API on first use. */
export async function getRoute(name: 'main' | 'detour'): Promise<RouteData> {
  return readRouteCache(name) ?? fetchRoute(name);
}

export async function getSimRoutes(): Promise<{ main: RouteData; detour: RouteData }> {
  const main = await getRoute('main');
  const detour = await getRoute('detour');
  return { main, detour };
}
