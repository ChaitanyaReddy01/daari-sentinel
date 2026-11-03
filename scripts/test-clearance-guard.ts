/* Clearance-guard unit tests: multi-incident scoring never goes NaN.
 * Run: npm run test:guard ($0: pure functions + cache reads only) */
import fs from 'node:fs';

import {
  displayClearance,
  resolveIncidentRange,
  safeClearance,
  type AgentAssessment,
} from '../src/lib/agent-guard';
import { agentCachePath, readAgentCache } from '../src/lib/agent';
import { planningDefault } from '../src/lib/clearance';
import {
  buildRouteGeom,
  fmtClock,
  fmtInt,
  fmtMi,
  fmtMin,
  formatElapsed,
  formatEta,
} from '../src/lib/sim';
import {
  buildStepSpeeds,
  pickFastest,
  scoreRouteWithIncidents,
  type ScoredIncident,
} from '../src/app/sim/drive';

let failures = 0;

function eq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    console.error(`FAIL ${msg}: got ${String(actual)}, want ${String(expected)}`);
    failures++;
  } else {
    console.log(`ok ${msg}`);
  }
}

function finite(n: unknown, msg: string): void {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    console.error(`FAIL ${msg}: got ${String(n)}, want a finite number`);
    failures++;
  } else {
    console.log(`ok ${msg}`);
  }
}

function mkAssessment(clearance: unknown): AgentAssessment {
  return {
    stage: 'no_responders',
    stageConfidence: 0.5,
    clearance: clearance as AgentAssessment['clearance'],
    confidence: 'medium',
    rangeReason: 'Fallback estimate from clearance table.',
    narrowsIf: 'Next camera report confirms scene.',
    lanes: { blocked: 'one', reopeningSoon: 'unknown' },
    evidence: [{ reportId: 'r1', second: 1, claim: 'truck burning on shoulder' }],
    changesSinceLast: 'First report',
    driverMessage: 'Fire ahead, use caution now.',
    uncertainties: ['Single report so far'],
  };
}

const TYPES = [
  'crash',
  'fire',
  'police_activity',
  'construction',
  'debris',
  'stalled_vehicle',
  'unknown',
];

/* ---- resolveIncidentRange: every type, every data quality ---- */

for (const type of TYPES) {
  const base = { reports: [{ t: 0, incident: true }], type, stage: 'no_responders', severity: null };
  // Valid assessment passes through (elapsed 0).
  const full = resolveIncidentRange(
    { ...base, assessments: [{ assessment: mkAssessment({ lowMin: 20, likelyMin: 30, highMin: 40 }), atT: 60 }] },
    60,
  );
  eq(`${full.lo}/${full.likely}/${full.hi}`, '20/30/40', `${type}: valid assessment passes through`);
  // Missing likelyMin derives the midpoint of the known ends.
  const mid = resolveIncidentRange(
    { ...base, assessments: [{ assessment: mkAssessment({ lowMin: 20, highMin: 40 }), atT: 60 }] },
    60,
  );
  eq(`${mid.lo}/${mid.likely}/${mid.hi}`, '20/30/40', `${type}: missing likelyMin is the midpoint`);
  // Missing everything: low/high fall back to the planning defaults for
  // type+stage, likelyMin derives from their midpoint.
  const fb = planningDefault(type, 'no_responders', null);
  const fbLikely = Math.round((fb.lowMin + fb.highMin) / 2);
  const none = resolveIncidentRange(
    { ...base, assessments: [{ assessment: mkAssessment({}), atT: 60 }] },
    60,
  );
  eq(`${none.lo}/${none.likely}/${none.hi}`, `${fb.lowMin}/${fbLikely}/${fb.highMin}`, `${type}: empty clearance uses planning defaults`);
  // NaN / Infinity ends fall back the same way.
  const poison = resolveIncidentRange(
    {
      ...base,
      assessments: [
        { assessment: mkAssessment({ lowMin: NaN, likelyMin: Infinity, highMin: NaN }), atT: 60 },
      ],
    },
    60,
  );
  eq(
    `${poison.lo}/${poison.likely}/${poison.hi}`,
    `${fb.lowMin}/${fbLikely}/${fb.highMin}`,
    `${type}: NaN/Infinity ends use planning defaults`,
  );
  // Missing atT (the /try import bug) counts age as 0, never NaN.
  const noAtT = resolveIncidentRange(
    {
      ...base,
      assessments: [
        { assessment: mkAssessment({ lowMin: 20, likelyMin: 30, highMin: 40 }), atT: undefined as unknown as number },
      ],
    },
    600,
  );
  eq(`${noAtT.lo}/${noAtT.likely}/${noAtT.hi}`, '20/30/40', `${type}: missing atT reads the full range`);
  // No assessment: planning table (work zones read as zero).
  const tab = resolveIncidentRange({ ...base, assessments: [] }, 60);
  if (type === 'construction') {
    eq(`${tab.lo}/${tab.likely}/${tab.hi}`, '0/0/0', 'construction without assessment reads zero');
  } else {
    eq(`${tab.lo}/${tab.likely}/${tab.hi}`, `${fb.lowMin}/${fb.likelyMin}/${fb.highMin}`, `${type}: no assessment uses the planning table`);
  }
}

// Aging still works: 10 min elapsed subtracts 10, floored at 0.
const aged = resolveIncidentRange(
  {
    reports: [{ t: 0, incident: true }],
    type: 'fire',
    stage: 'no_responders',
    severity: 'moderate',
    assessments: [{ assessment: mkAssessment({ lowMin: 30, likelyMin: 45, highMin: 60 }), atT: 0 }],
  },
  600,
);
eq(`${aged.lo}/${aged.likely}/${aged.hi}`, '20/35/50', 'fire assessment ages 10 min');

// safeClearance orders a finite-but-unordered triple and reports the fix.
const reordered = safeClearance(
  { lowMin: 50, likelyMin: 10, highMin: 40 },
  { lowMin: 30, likelyMin: 45, highMin: 60 },
  'test',
);
eq(`${reordered.lowMin}/${reordered.likelyMin}/${reordered.highMin}`, '10/40/50', 'unordered triple is reordered');
eq(reordered.fixed, true, 'unordered triple reports fixed');
const clean = safeClearance(
  { lowMin: 20, likelyMin: 30, highMin: 40 },
  { lowMin: 30, likelyMin: 45, highMin: 60 },
  'test',
);
eq(clean.fixed, false, 'valid triple is untouched');

// displayClearance: stale with no clearing report stays "unconfirmed".
const stale = displayClearance(mkAssessment({ lowMin: 30, likelyMin: 45, highMin: 60 }), 61, false);
eq(stale.unconfirmed, true, 'stale assessment is unconfirmed');
eq(`${stale.lowMin}/${stale.likelyMin}/${stale.highMin}`, '0/5/10', 'unconfirmed range is 0/5/10');

/* ---- scoreRouteWithIncidents: multi-incident accumulation ---- */

const geom = buildRouteGeom([
  { lat: 41.0, lng: -73.0 },
  { lat: 41.1, lng: -73.0 },
]);
const speeds = buildStepSpeeds([{ distanceMeters: geom.length, durationSeconds: 400 }], geom.length, 26.8);
const atS = (s: number): { lat: number; lng: number } => ({ lat: 41.0 + s / 111320, lng: -73.0 });

function scored(type: string, s: number, lanes: string, clearance: unknown): ScoredIncident {
  const range = resolveIncidentRange(
    {
      reports: [{ t: 0, incident: true }],
      type,
      stage: 'no_responders',
      severity: type === 'crash' ? 'severe' : 'moderate',
      assessments: [{ assessment: mkAssessment(clearance), atT: 0 }],
    },
    60,
  );
  return { ...atS(s), lanesBlocked: lanes, firstReportT: 0, range };
}

const allTypes: ScoredIncident[] = [
  scored('crash', 2000, 'two', { lowMin: 55, likelyMin: 72, highMin: 95 }),
  scored('fire', 3000, 'one', { lowMin: 30, likelyMin: 45, highMin: 60 }),
  scored('police_activity', 4000, 'shoulder', { lowMin: 10, likelyMin: 20, highMin: 30 }),
  scored('construction', 5000, 'two', { lowMin: 70, likelyMin: 90, highMin: 115 }),
  scored('debris', 6000, 'one', { lowMin: 10, likelyMin: 15, highMin: 25 }),
  scored('stalled_vehicle', 7000, 'one', { lowMin: 10, likelyMin: 15, highMin: 25 }),
  scored('unknown', 8000, 'all', { lowMin: 10, likelyMin: 25, highMin: 45 }),
  // The old shape: no likelyMin at all (fire, like the hay-bale report).
  scored('fire', 9000, 'one', { lowMin: 30, highMin: 60 }),
];

const multi = scoreRouteWithIncidents({
  geom,
  speeds,
  fromS: 0,
  simNow: 60,
  startOffsetSec: 0,
  baseMps: 26.8,
  lateralMeters: 300,
  incidents: allTypes,
});
finite(multi.total, 'multi-incident total is finite');
finite(multi.totalLo, 'multi-incident totalLo is finite');
finite(multi.totalHi, 'multi-incident totalHi is finite');
eq(multi.totalLo <= multi.total && multi.total <= multi.totalHi, true, 'multi-incident range is ordered');
eq(multi.total >= multi.drive, true, 'multi-incident total covers the drive');

// A poisoned range (bypassing resolution) is skipped, not propagated.
const poisoned: ScoredIncident[] = [
  ...allTypes.slice(0, 2),
  { ...atS(4000), lanesBlocked: 'one', firstReportT: 0, range: { lo: NaN, likely: NaN, hi: NaN } },
];
const clean2 = scoreRouteWithIncidents({
  geom,
  speeds,
  fromS: 0,
  simNow: 60,
  startOffsetSec: 0,
  baseMps: 26.8,
  lateralMeters: 300,
  incidents: allTypes.slice(0, 2),
});
const withPoison = scoreRouteWithIncidents({
  geom,
  speeds,
  fromS: 0,
  simNow: 60,
  startOffsetSec: 0,
  baseMps: 26.8,
  lateralMeters: 300,
  incidents: poisoned,
});
eq(withPoison.total, clean2.total, 'poisoned incident is skipped, totals unchanged');
finite(withPoison.total, 'totals stay finite with a poisoned incident');

/* ---- pickFastest: ranking ignores non-finite scores ---- */

eq(pickFastest(100, { totalSec: 120, suggest: false }, null), 'stay', 'stay wins by default');
eq(pickFastest(100, { totalSec: 120, suggest: true }, null), 'stay', 'slower suggested reroute loses');
eq(pickFastest(100, { totalSec: 80, suggest: true }, null), 'reroute', 'faster suggested reroute wins');
eq(pickFastest(100, { totalSec: 80, suggest: false }, null), 'stay', 'unsuggested reroute never wins');
eq(pickFastest(100, null, 90), 'stop', 'faster stop wins');
eq(pickFastest(100, { totalSec: 80, suggest: true }, 70), 'stop', 'stop beats reroute when lowest');
eq(pickFastest(NaN, { totalSec: 80, suggest: true }, null), 'reroute', 'NaN stay loses to a finite reroute');
eq(pickFastest(NaN, { totalSec: 80, suggest: false }, 90), 'stop', 'NaN stay loses to a finite stop');
eq(pickFastest(NaN, { totalSec: NaN, suggest: true }, null), 'stay', 'NaN reroute never wins');
eq(pickFastest(NaN, null, NaN), 'stay', 'all-NaN falls back to stay');
eq(pickFastest(Infinity, { totalSec: 80, suggest: true }, null), 'reroute', 'Infinite stay loses to reroute');

/* ---- formatters never render NaN ---- */

for (const bad of [NaN, Infinity, -Infinity]) {
  eq(formatEta(0, bad), '–', `formatEta guards ${String(bad)}`);
  eq(formatEta(bad, 0), '–', `formatEta guards elapsed ${String(bad)}`);
  eq(formatElapsed(bad), '–', `formatElapsed guards ${String(bad)}`);
  eq(fmtInt(bad), '–', `fmtInt guards ${String(bad)}`);
  eq(fmtMi(bad), '–', `fmtMi guards ${String(bad)}`);
  eq(fmtMin(bad), '–', `fmtMin guards ${String(bad)}`);
  eq(fmtClock(bad), '–', `fmtClock guards ${String(bad)}`);
}
eq(formatEta(0, 0), '9:00 AM', 'formatEta sim start');
eq(formatElapsed(125), 't+2:05', 'formatElapsed normal');
eq(fmtInt(4.6), '5', 'fmtInt rounds');
eq(fmtMi(1609.344), '1.0 mi', 'fmtMi one mile');
eq(fmtMin(300), '5 min', 'fmtMin five minutes');
eq(fmtClock(125), '2:05', 'fmtClock normal');

/* ---- readAgentCache: malformed entries are a miss ---- */

const BAD_KEY = 'zz-test-guard-malformed';
const OLD_KEY = 'zz-test-guard-oldversion';
const GOOD_KEY = 'zz-test-guard-good';
try {
  // Crash-1 single-report entry is a known v3 hit; reuse its file bytes.
  const valid = JSON.parse(
    fs.readFileSync('data/snapshot/agent/d0feee0d8c45f7f8c5fcd96de621f421cb6b0e602547a0c2432fb0caf6fd30c7.json', 'utf8'),
  ) as { assessment: unknown };
  fs.writeFileSync(
    agentCachePath(BAD_KEY),
    JSON.stringify({
      ...valid,
      assessment: {
        ...(valid.assessment as Record<string, unknown>),
        clearance: { lowMin: 1, midMin: 2, highMin: 3 },
      },
    }),
  );
  fs.writeFileSync(agentCachePath(OLD_KEY), JSON.stringify({ ...valid, agentVersion: 2 }));
  fs.writeFileSync(agentCachePath(GOOD_KEY), JSON.stringify(valid));
  eq(readAgentCache(BAD_KEY), null, 'v3-shaped entry without likelyMin is a miss');
  eq(readAgentCache(OLD_KEY), null, 'old-version entry is a miss');
  const good = readAgentCache(GOOD_KEY);
  eq(good !== null && (good.assessment.clearance as { likelyMin: number }).likelyMin, 72, 'valid v3 entry still hits');
} finally {
  for (const k of [BAD_KEY, OLD_KEY, GOOD_KEY]) {
    try {
      fs.unlinkSync(agentCachePath(k));
    } catch {
      /* already gone */
    }
  }
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('clearance guard: all green');
}
