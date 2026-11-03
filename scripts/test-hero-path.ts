/* Hero You-car path tests: the detour, ramps and car share ONE geometry.
 * The You car rides #hs-detour via mpath, so these static checks on the
 * path data itself guard the reported bug (car on I-95 next to the crash
 * while the highlight sits on CT-15, highlight offset from the ramp).
 * Run: npm run test:hero-path ($0: source reads + math only) */
import fs from 'node:fs';

const SRC = process.env.HERO_SRC || 'src/app/landing/hero-scene.tsx';
const src = fs.readFileSync(SRC, 'utf8');
const css = fs.readFileSync('src/app/globals.css', 'utf8');

let failures = 0;

function ok(cond: boolean, msg: string, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${msg}${detail ? `: ${detail}` : ''}`);
    failures++;
  } else {
    console.log(`ok ${msg}`);
  }
}

type Pt = { x: number; y: number };

/** Minimal absolute M/L/C path parser for the hero scene's `d` strings. */
function parsePath(d: string): Pt[][] {
  const tokens = d.replace(/,/g, ' ').trim().split(/\s+/);
  const subpaths: Pt[][] = [];
  let cur: Pt[] = [];
  let cx = 0;
  let cy = 0;
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      if (cur.length > 0) subpaths.push(cur);
      cx = num();
      cy = num();
      cur = [{ x: cx, y: cy }];
    } else if (cmd === 'L') {
      cx = num();
      cy = num();
      cur.push({ x: cx, y: cy });
    } else if (cmd === 'C') {
      const p0 = { x: cx, y: cy };
      const p1 = { x: num(), y: num() };
      const p2 = { x: num(), y: num() };
      const p3 = { x: num(), y: num() };
      for (let s = 1; s <= 200; s++) {
        const t = s / 200;
        const mt = 1 - t;
        cur.push({
          x:
            mt * mt * mt * p0.x +
            3 * mt * mt * t * p1.x +
            3 * mt * t * t * p2.x +
            t * t * t * p3.x,
          y:
            mt * mt * mt * p0.y +
            3 * mt * mt * t * p1.y +
            3 * mt * t * t * p2.y +
            t * t * t * p3.y,
        });
      }
      cx = p3.x;
      cy = p3.y;
    } else {
      throw new Error(`unsupported path token ${cmd} in ${d}`);
    }
  }
  if (cur.length > 0) subpaths.push(cur);
  return subpaths;
}

function samples(d: string): Pt[] {
  return parsePath(d).flat();
}

/** Extract the `d` of the path whose tag contains `marker`
 * (`after`: the first path tag following the marker, for markers in
 * comments that precede their paths). */
function findD(marker: string, after = false): string {
  const idx = src.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found: ${marker}`);
  const tagStart = after ? src.indexOf('<path', idx) : src.lastIndexOf('<path', idx);
  if (tagStart < 0) throw new Error(`no path near marker: ${marker}`);
  const tag = src.slice(tagStart, src.indexOf('/>', tagStart));
  const m = tag.match(/\sd="([^"]+)"/);
  if (!m) throw new Error(`no d near marker: ${marker}`);
  return m[1];
}

const norm = (s: string): string => s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

// The one detour path, the two ramp roads, and the reduced-motion detour.
const detour = norm(findD('id="hs-detour"'));
const exitRamp = norm(findD('Exit 38 ramp', true));
const entranceRamp = norm(findD('Entrance ramp', true));
const staticDetour = norm(findD('scene-static', true));

ok(detour.length > 0, 'detour path #hs-detour exists');
ok(exitRamp.length > 0, 'exit ramp road exists');
ok(entranceRamp.length > 0, 'entrance ramp road exists');
ok(staticDetour.length > 0, 'static detour exists');

// 1. Ramps share the detour's exact curve geometry (same substrings).
const EXIT_CURVE = 'C 140 196 142 120 150 73';
const ENTRANCE_CURVE = 'C 406 130 408 196 440 196';
ok(detour.includes(EXIT_CURVE), 'detour contains the exit curve');
ok(detour.includes(ENTRANCE_CURVE), 'detour contains the entrance curve');
ok(exitRamp === 'M 110 196 ' + EXIT_CURVE, 'exit ramp road matches the detour subpath', exitRamp);
ok(
  entranceRamp === 'M 398 73 ' + ENTRANCE_CURVE,
  'entrance ramp road matches the detour subpath',
  entranceRamp,
);
ok(
  staticDetour === `M 110 196 ${EXIT_CURVE} L 398 73 ${ENTRANCE_CURVE}`,
  'static detour matches the detour ramp-to-ramp portion',
  staticDetour,
);

// 2. The car rides the path via mpath and turns with the ramps.
ok(src.includes('<mpath href="#hs-detour"'), 'You car references #hs-detour via mpath');
ok(src.includes('rotate="auto"'), 'You car turns with the path (rotate=auto)');
ok(!css.includes('@keyframes sc3-you'), 'old You transform keyframes are gone');

// 3. The detour stays clear of the crash marker at (312, 196).
const CRASH = { x: 312, y: 196 };
const pts = samples(detour);
let minCrash = Infinity;
for (const p of pts) minCrash = Math.min(minCrash, Math.hypot(p.x - CRASH.x, p.y - CRASH.y));
ok(minCrash >= 60, 'detour never within 60px of the crash', `min ${minCrash.toFixed(1)}px`);

// 4. The detour touches the I-95 band (y 180-244) only before the exit
//    ramp (x <= 145) and after the entrance ramp (x >= 405).
const bad = pts.filter((p) => p.y >= 180 && p.x > 145 && p.x < 405);
ok(bad.length === 0, 'detour never on I-95 between the ramps', bad.length > 0 ? `e.g. (${bad[0].x.toFixed(1)}, ${bad[0].y.toFixed(1)})` : '');

// 5. Reduced-motion frame: the You car sits on CT-15 (lane center y = 73)
//    within the detour's CT-15 span, with the highlighted detour.
const staticBlock = src.slice(src.indexOf('scene-static'));
const youUse = staticBlock.match(/<use href="#hs-car" x="([\d.]+)" y="([\d.]+)" width="42" height="([\d.]+)" \/>/);
ok(youUse !== null, 'static You car uses the sprite');
if (youUse) {
  const cx = Number(youUse[1]) + 42 / 2;
  const cy = Number(youUse[2]) + Number(youUse[3]) / 2;
  ok(Math.abs(cy - 73) <= 1, 'static You car is on CT-15', `center y=${cy}`);
  ok(cx >= 150 && cx <= 398, 'static You car is within the detour span', `center x=${cx}`);
}

if (failures > 0) {
  console.error(`${failures} hero-path check(s) failed`);
  process.exit(1);
}
console.log('hero-path: all checks passed');
