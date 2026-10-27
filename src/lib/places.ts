import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-only Places API (New) client: details + nearby search.
 * Never import from client components.
 */

const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache', 'places');
const LEDGER_PATH = path.join(process.cwd(), 'data', 'ledger.jsonl');

export interface NearbyStop {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  types: string[];
}

function serverKey(): string {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_SERVER_KEY is not set.');
  return key;
}

function appendPlacesLedger(what: 'details' | 'nearby'): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(
    LEDGER_PATH,
    JSON.stringify({
      ts: new Date().toISOString(),
      model: 'places-api',
      kind: 'places',
      what,
      estUSD: 0,
    }) + '\n',
  );
}

async function googleFetch(url: string, init: RequestInit, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(
      `Places API ${what} request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Places API ${what} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as unknown;
}

/** Gas stations, rest stops and coffee near a point. Cached per location. */
export async function searchStops(lat: number, lng: number): Promise<NearbyStop[]> {
  const key = `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  const cachePath = path.join(CACHE_DIR, `nearby-${key}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as NearbyStop[];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Cache miss: fetch below.
  }
  const data = (await googleFetch(
    NEARBY_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': serverKey(),
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.location,places.types',
      },
      body: JSON.stringify({
        includedTypes: ['gas_station', 'cafe', 'convenience_store'],
        maxResultCount: 10,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius: 1000.0 },
        },
        rankPreference: 'DISTANCE',
      }),
    },
    'nearby',
  )) as {
    places?: Array<{
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      types?: string[];
    }>;
  };
  const out: NearbyStop[] = [];
  for (const p of data.places ?? []) {
    if (typeof p.location?.latitude !== 'number' || typeof p.location?.longitude !== 'number') {
      continue;
    }
    out.push({
      id: typeof p.id === 'string' ? p.id : '',
      name: p.displayName?.text ?? '',
      address: p.formattedAddress ?? '',
      lat: p.location.latitude,
      lng: p.location.longitude,
      types: Array.isArray(p.types) ? p.types.filter((t): t is string => typeof t === 'string') : [],
    });
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(out));
  appendPlacesLedger('nearby');
  return out;
}
