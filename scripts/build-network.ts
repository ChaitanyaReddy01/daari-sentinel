/**
 * Build the network-demo population: 10 corridor trips (main route plus
 * alternatives each) and ~40 staggered drivers. LOCAL ONLY: uses the Routes
 * API with GOOGLE_MAPS_SERVER_KEY and commits the results to
 * data/snapshot/network/ so the demo runs at $0.
 *
 * Usage: npx tsx scripts/build-network.ts [--yes]
 *
 * Prints the number of Routes calls first (cache hits cost $0) and asks
 * for "y" before any API call (skip with --yes).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'data', 'snapshot', 'network');

interface TripDef {
  id: string;
  /** Short card label, e.g. 'Bridgeport → JFK'. */
  label: string;
  origin: string;
  destination: string;
  direction: 'sb' | 'nb';
}

const TRIPS: TripDef[] = [
  { id: 'newhaven-jfk', label: 'New Haven → JFK', origin: 'New Haven, CT', destination: 'JFK Airport, NY', direction: 'sb' },
  { id: 'bridgeport-jfk', label: 'Bridgeport → JFK', origin: 'Bridgeport, CT', destination: 'JFK Airport, NY', direction: 'sb' },
  { id: 'bridgeport-times', label: 'Bridgeport → Times Square', origin: 'Bridgeport, CT', destination: 'Times Square, New York, NY', direction: 'sb' },
  { id: 'stamford-lga', label: 'Stamford → LaGuardia', origin: 'Stamford, CT', destination: 'LaGuardia Airport, NY', direction: 'sb' },
  { id: 'hartford-times', label: 'Hartford → Times Square', origin: 'Hartford, CT', destination: 'Times Square, New York, NY', direction: 'sb' },
  { id: 'milford-ewr', label: 'Milford → Newark', origin: 'Milford, CT', destination: 'Newark Airport, NJ', direction: 'sb' },
  { id: 'fairfield-yankee', label: 'Fairfield → Yankee Stadium', origin: 'Fairfield, CT', destination: 'Yankee Stadium, Bronx, NY', direction: 'sb' },
  { id: 'westport-whiteplains', label: 'Westport → White Plains', origin: 'Westport, CT', destination: 'White Plains, NY', direction: 'sb' },
  { id: 'times-newhaven', label: 'Times Square → New Haven', origin: 'Times Square, New York, NY', destination: 'New Haven, CT', direction: 'nb' },
  { id: 'jfk-bridgeport', label: 'JFK → Bridgeport', origin: 'JFK Airport, NY', destination: 'Bridgeport, CT', direction: 'nb' },
];

/** Deterministic PRNG (mulberry32) for repeatable stagger + choice rolls. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fail(message: string): never {
  console.error(`build-network: ${message}`);
  process.exit(1);
}

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const t = answer.trim().toLowerCase();
      resolve(t === 'y' || t === 'yes');
    });
  });
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  if (!process.env.GOOGLE_MAPS_SERVER_KEY) {
    try {
      const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
      const m = raw.match(/^GOOGLE_MAPS_SERVER_KEY=\s*(.+?)\s*$/m);
      if (m) process.env.GOOGLE_MAPS_SERVER_KEY = m[1].replace(/^"|"$/g, '');
    } catch {
      // Fall through to getTrip's own key check.
    }
  }
  const { getTrip } = await import('../src/lib/trip');

  // Dry run with live calls off: every miss is one Routes call we'd make.
  delete process.env.LIVE_CALLS;
  const missing: string[] = [];
  for (const t of TRIPS) {
    try {
      await getTrip({ origin: { address: t.origin }, destination: { address: t.destination } }, 'build-network');
    } catch {
      missing.push(t.id);
    }
  }
  console.log(
    `build-network: ${TRIPS.length} trips, ${TRIPS.length - missing.length} cached, ` +
      `${missing.length} Routes call(s) needed${missing.length > 0 ? ` (${missing.join(', ')})` : ''}.`,
  );
  if (
    missing.length > 0 &&
    !process.argv.includes('--yes') &&
    !(await askYesNo(`Fetch ${missing.length} trip(s) from the Routes API? [y/N] `))
  ) {
    console.log('build-network: aborted by user.');
    process.exit(1);
  }

  process.env.LIVE_CALLS = 'true';
  const tripsOut: { id: string; label: string; origin: string; destination: string; direction: string; routes: unknown[] }[] = [];
  for (const t of TRIPS) {
    const res = await getTrip(
      { origin: { address: t.origin }, destination: { address: t.destination } },
      'build-network',
    );
    if (!Array.isArray(res.routes) || res.routes.length === 0) fail(`no routes for ${t.id}.`);
    tripsOut.push({ id: t.id, label: t.label, origin: t.origin, destination: t.destination, direction: t.direction, routes: res.routes });
    console.log(`build-network: ${t.id}: ${res.routes.length} route(s).`);
  }

  // 4 drivers per trip: starts spread from 5 min ahead of you to 40 min
  // behind you, clamped so every driver is still on the road at t+50 min.
  // (Your camera's report helps the drivers behind it; a few ahead of it
  // show as already past.) Seeded choice rolls: 75% fastest / 15% stay /
  // 10% stop & wait.
  const rand = rng(20251029);
  const mainDur = new Map(
    tripsOut.map((t) => {
      const r0 = t.routes[0] as { durationSeconds?: unknown };
      const dur = typeof r0.durationSeconds === 'number' ? r0.durationSeconds : 3600;
      return [t.id, dur] as const;
    }),
  );
  const driversOut: { id: string; tripId: string; startOffsetSec: number; choiceRoll: number }[] = [];
  for (const t of TRIPS) {
    const minOffset = 50 * 60 - (mainDur.get(t.id) ?? 3600);
    for (let k = 0; k < 4; k += 1) {
      const raw = Math.round((-5 + rand() * 45) * 60);
      driversOut.push({
        id: `${t.id}-d${k + 1}`,
        tripId: t.id,
        startOffsetSec: Math.max(raw, minOffset),
        choiceRoll: rand(),
      });
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'trips.json'), `${JSON.stringify(tripsOut)}\n`);
  fs.writeFileSync(path.join(OUT_DIR, 'drivers.json'), `${JSON.stringify(driversOut)}\n`);
  const bytes =
    fs.statSync(path.join(OUT_DIR, 'trips.json')).size +
    fs.statSync(path.join(OUT_DIR, 'drivers.json')).size;
  console.log(
    `build-network: wrote ${OUT_DIR} (${tripsOut.length} trips, ${driversOut.length} drivers, ${(bytes / 1024).toFixed(0)} KB).`,
  );
}

main().catch((err) => {
  console.error(`build-network: fatal: ${err instanceof Error && err.message ? err.message : String(err)}`);
  process.exit(1);
});
