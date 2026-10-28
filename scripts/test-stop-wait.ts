/* Step 7b stop-and-wait unit tests. Run: npm run test:stop */
import { stopWaitEstimate } from '../src/app/sim/drive';

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

// Screenshot case: clears in about 69 min (52-92), 24 min away via the stop.
// The old code waited out the *delay* (~14 min); the fix waits out the clearance.
const shot = stopWaitEstimate({
  clearLoMin: 52,
  clearLikelyMin: 69,
  clearHiMin: 92,
  toStopMin: 10,
  stopToIncidentMin: 14,
  stopToDestMin: 60,
});
eq(shot !== null, true, 'shot offered');
if (shot) {
  approx(shot.waitMin, 45, 'shot wait'); // 69 - 24
  approx(shot.waitLoMin, 28, 'shot wait lo'); // 52 - 24
  approx(shot.waitHiMin, 68, 'shot wait hi'); // 92 - 24
  approx(shot.arrivalMin, 118, 'shot arrival'); // 10 + 45 + 60 + 3
  approx(shot.arrivalLoMin, 101, 'shot arrival lo'); // 10 + 28 + 60 + 3
  approx(shot.arrivalHiMin, 141, 'shot arrival hi'); // 10 + 68 + 60 + 3
}

// Incident clears before you would reach it -> no STOP option.
eq(
  stopWaitEstimate({
    clearLoMin: 5,
    clearLikelyMin: 12,
    clearHiMin: 20,
    toStopMin: 10,
    stopToIncidentMin: 14,
    stopToDestMin: 60,
  }),
  null,
  'hide when cleared first',
);

// Short clearance -> minimum 5-min wait.
const quick = stopWaitEstimate({
  clearLoMin: 8,
  clearLikelyMin: 12,
  clearHiMin: 18,
  toStopMin: 4,
  stopToIncidentMin: 4,
  stopToDestMin: 50,
});
eq(quick !== null, true, 'short offered');
if (quick) {
  approx(quick.waitMin, 5, 'short wait floors at 5'); // max(5, 12 - 8)
  approx(quick.arrivalMin, 62, 'short arrival'); // 4 + 5 + 50 + 3
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('stop-wait: all green');
}
