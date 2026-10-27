/* P4b jam-model unit tests. Run: npm run test:jam */
import {
  blockageFactor,
  decideByLabel,
  longestRoad,
  parseDecideByLabel,
  rerouteDelayMin,
  residualQueueMin,
  routeName,
  routesRemainSec,
  stayDelayRange,
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

function approx(actual: number, expected: number, msg: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    console.error(`FAIL ${msg}: got ${actual}, want ${expected}`);
    failures++;
  } else {
    console.log(`ok ${msg}`);
  }
}

// Demo unit case: T=20, crash/no_responders/severe -> 68-113 (mid 90.5), lanes two.
const stay = stayDelayRange(20, 68, 90.5, 113, 'two', 0);
approx(stay.lo, 41.4, 'stay/lo');
approx(stay.mid, 59.4, 'stay/mid');
approx(stay.hi, 77.4, 'stay/hi');
// STAY is clearly slower than a demo-scale REROUTE (+5 min detour).
eq(stay.lo > rerouteDelayMin(600, 4200, 4500), true, 'stay range above reroute delay');
eq(rerouteDelayMin(600, 3000, 4500), 0, 'reroute delay never negative');
// Past clearance -> residual queue only (2-5 min by incident age).
eq(stayDelayRange(120, 68, 90.5, 113, 'two', 0).mid, 2, 'residual fresh');
eq(stayDelayRange(120, 68, 90.5, 113, 'two', 60).mid, 5, 'residual old');
eq(stayDelayRange(120, 68, 90.5, 113, 'two', 400).mid, 5, 'residual capped');
eq(residualQueueMin(0), 2, 'residualQueueMin fresh');
// Blockage factors.
eq(blockageFactor('all'), 1, 'blockage all');
eq(blockageFactor('two'), 0.8, 'blockage two');
eq(blockageFactor('one'), 0.5, 'blockage one');
eq(blockageFactor('shoulder'), 0.2, 'blockage shoulder');
eq(blockageFactor('unknown'), 0.6, 'blockage unknown');
eq(blockageFactor('none'), 0, 'blockage none');
eq(blockageFactor('bogus'), 0.6, 'blockage fallback');
// Decide-by labels come from the exit/road, never "Continue straight".
eq(parseDecideByLabel('Take exit 26 toward US-1'), 'Exit 26 (US-1)', 'decide exit+road');
eq(parseDecideByLabel('Take Exit 7A on the left'), 'Exit 7A', 'decide exit only');
eq(parseDecideByLabel('Continue straight to stay on I-95 S'), 'I-95', 'decide road only');
eq(parseDecideByLabel('Take exit 38 toward CT-15/Merritt Pkwy'), 'Exit 38 (CT-15)', 'decide state route');
eq(parseDecideByLabel('Turn left'), null, 'decide nothing');
// Route names: API description wins, else the road with the most distance.
const steps = [
  { distanceMeters: 5000, instruction: 'Continue on I-95 S' },
  { distanceMeters: 2000, instruction: 'Take exit 26 toward US-1' },
  { distanceMeters: 3000, instruction: 'Continue on US-1' },
];
eq(longestRoad(steps), 'I-95', 'longest road');
eq(longestRoad([{ distanceMeters: 9, instruction: 'Turn left' }]), null, 'longest road none');
eq(routeName('US-1 N', steps), 'US-1 N', 'routeName prefers description');
eq(routeName(null, steps), 'I-95', 'routeName falls back');
eq(routeName('  ', steps), 'I-95', 'routeName blank falls back');
// Duration proration.
eq(routesRemainSec(3600, 100000, 25000), 2700, 'prorate quarter');
eq(routesRemainSec(3600, 100000, 200000), 0, 'prorate past end');
// Decide-by scans forward from the step containing the divergence point.
eq(decideByLabel(steps, 6000), 'Exit 26 (US-1)', 'decide scan finds exit');
eq(decideByLabel(steps, 0), 'I-95', 'decide scan at zero');
eq(decideByLabel([], 10), null, 'decide scan empty');
eq(
  decideByLabel(
    [
      { distanceMeters: 100, instruction: 'Turn left' },
      { distanceMeters: 100, instruction: 'Take exit 5' },
    ],
    10,
  ),
  'Exit 5',
  'decide scan skips bare steps',
);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('jam model: all green');
}
