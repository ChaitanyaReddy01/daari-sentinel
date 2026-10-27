import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-only trip routing: origin → destination with alternatives and step
 * instructions. Never import from client components.
 */

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.navigationInstruction',
].join(',');
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache', 'routes');
const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');

export interface TripStep {
  distanceMeters: number;
  instruction: string | null;
}

export interface TripRoute {
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
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
  const cachePath = path.join(CACHE_DIR, `trip-${cacheKey}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { routes: TripRoute[] };
    if (parsed && Array.isArray(parsed.routes) && parsed.routes.length > 0) return parsed;
  } catch {
    // Cache miss: fetch below.
  }

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
      polyline?: { encodedPolyline?: string };
      legs?: Array<{
        steps?: Array<{
          distanceMeters?: number;
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
        steps.push({
          distanceMeters: typeof s.distanceMeters === 'number' ? s.distanceMeters : 0,
          instruction:
            typeof s.navigationInstruction?.instructions === 'string'
              ? s.navigationInstruction.instructions
              : null,
        });
      }
    }
    routes.push({
      encodedPolyline: poly,
      distanceMeters: r.distanceMeters,
      durationSeconds: seconds ? parseInt(seconds, 10) : 0,
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
