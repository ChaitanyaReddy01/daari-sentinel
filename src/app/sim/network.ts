/**
 * Step 8e network demo: one camera report, many drivers.
 *
 * Pure engine — no React, no fetches. Route geometry comes from
 * src/lib/sim.ts and option scoring reuses src/app/sim/drive.ts, so each
 * notified driver gets the same Stay / Reroute / Stop & wait math as you.
 */

import {
  MPH_TO_MPS,
  buildRouteGeom,
  decodePolyline,
  nearestOnRoute,
  pointAt,
  type LatLng,
  type RouteGeom,
} from '../../lib/sim';
import {
  buildStepSpeeds,
  minDistanceToRoute,
  projectToSWithSpeeds,
  routeName,
  routesRemainSec,
  speedAtSpeeds,
  stayDelayRange,
  stopWaitEstimate,
  type StepSpeed,
} from './drive';

/** One route of the committed network snapshot (scripts/build-network.ts). */
export interface NetRouteSnap {
  description: string | null;
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
  steps: { distanceMeters: number; durationSeconds: number; instruction: string | null }[];
}

/** One trip of the committed network snapshot. */
export interface NetTripSnap {
  id: string;
  label: string;
  direction: 'sb' | 'nb';
  routes: NetRouteSnap[];
}

/** One driver row of the committed network snapshot. */
export interface NetDriverSnap {
  id: string;
  tripId: string;
  startOffsetSec: number;
  choiceRoll: number;
}

/** The incident, as the drivers see it (one incident per scenario). */
export interface NetIncident {
  lat: number;
  lng: number;
  direction: 'sb' | 'nb';
  /** Remaining clearance ends in sim minutes, counted down already. */
  clearLoMin: number;
  clearLikelyMin: number;
  clearHiMin: number;
  lanes: string;
  ageMin: number;
  cleared: boolean;
}

export type NetStatus =
  | 'unaffected'
  | 'alerted'
  | 'rerouted'
  | 'stayed'
  | 'waiting';

export type NetChoice = 'stay' | 'reroute' | 'stop' | null;

export interface NetDriver {
  id: string;
  tripId: string;
  tripLabel: string;
  direction: 'sb' | 'nb';
  geoms: RouteGeom[];
  speeds: StepSpeed[][];
  routeNames: string[];
  routeIdx: number;
  distancesM: number[];
  durationsSec: number[];
  steps: NetRouteSnap['steps'][];
  descriptions: (string | null)[];
  /** Sim seconds at scenario t=0 when this driver starts (negative = early). */
  startOffsetSec: number;
  choiceRoll: number;
  s: number;
  started: boolean;
  arrived: boolean;
  notifiedAt: number | null;
  decideAt: number | null;
  status: NetStatus;
  choice: NetChoice;
  /** Minutes saved vs staying, when positive. */
  savedMin: number;
  /** Incident arclength on the active route, set when notified. */
  incidentS: number | null;
}

export interface NetOptions {
  stayMin: number;
  rerouteMin: number | null;
  rerouteIdx: number | null;
  rerouteAvoidsAll: boolean;
  /** Present when no alternative avoids every active incident. */
  fewestDelaysReason: string | null;
  stopMin: number | null;
  stopWaitMin: number | null;
  best: 'stay' | 'reroute' | 'stop';
  bestReason: string | null;
  incidentAhead: boolean;
}

export interface NetCounts {
  notified: number;
  rerouted: number;
  stayed: number;
  waiting: number;
  savedDriverMin: number;
  unaffected: number;
}

/** Base cruise speed for network drivers (m/s), same as your car. */
export const NET_BASE_MPS = 60 * MPH_TO_MPS;
/** Sim seconds a notified driver takes to decide. */
export const NET_DECIDE_DELAY_SEC = 45;
/** Extra minutes one rerouting driver adds to an alternative. */
export const NET_DETOUR_LOAD_MIN = 0.15;
/** Cap on the detour load per alternative (minutes). */
export const NET_DETOUR_LOAD_CAP_MIN = 8;
/** Switch suggestion threshold: minutes or share of remaining time. */
export const NET_SWITCH_MIN = 3;
export const NET_SWITCH_FRAC = 0.1;

/** Build live drivers from the committed snapshot rows. */
export function buildDrivers(
  trips: NetTripSnap[],
  drivers: NetDriverSnap[],
): NetDriver[] {
  const byId = new Map(trips.map((t) => [t.id, t]));
  const out: NetDriver[] = [];
  for (const row of drivers) {
    const trip = byId.get(row.tripId);
    if (!trip || trip.routes.length === 0) continue;
    const geoms = trip.routes.map((r) => buildRouteGeom(decodePolyline(r.encodedPolyline)));
    const speeds = trip.routes.map((r, i) =>
      buildStepSpeeds(r.steps, geoms[i].length, NET_BASE_MPS),
    );
    // Pre-roll drivers who started before t=0 so the corridor is already
    // spread out when the scenario begins.
    let s0 = 0;
    if (row.startOffsetSec < 0) {
      let t = row.startOffsetSec;
      while (t < 0) {
        const dt = Math.min(10, -t);
        s0 += speedAtSpeeds(speeds[0], s0, NET_BASE_MPS) * dt;
        t += dt;
      }
      s0 = Math.min(s0, geoms[0].length);
    }
    out.push({
      id: row.id,
      tripId: trip.id,
      tripLabel: trip.label ?? trip.id,
      direction: trip.direction,
      geoms,
      speeds,
      routeNames: trip.routes.map((r) => routeName(r.description, r.steps)),
      routeIdx: 0,
      distancesM: trip.routes.map((r) => r.distanceMeters),
      durationsSec: trip.routes.map((r) => r.durationSeconds),
      steps: trip.routes.map((r) => r.steps),
      descriptions: trip.routes.map((r) => r.description),
      startOffsetSec: row.startOffsetSec,
      choiceRoll: row.choiceRoll,
      s: s0,
      started: row.startOffsetSec <= 0,
      arrived: s0 >= geoms[0].length,
      notifiedAt: null,
      decideAt: null,
      status: 'unaffected',
      choice: null,
      savedMin: 0,
      incidentS: null,
    });
  }
  return out;
}

/** Advance every driver along their active route by dt sim seconds. */
export function advanceDrivers(
  drivers: NetDriver[],
  simSec: number,
  dt: number,
): void {
  for (const d of drivers) {
    if (!d.started && simSec >= d.startOffsetSec) d.started = true;
    if (!d.started || d.arrived) continue;
    const geom = d.geoms[d.routeIdx];
    const v = speedAtSpeeds(d.speeds[d.routeIdx], d.s, NET_BASE_MPS);
    d.s += v * dt;
    if (d.s >= geom.length) {
      d.s = geom.length;
      d.arrived = true;
    }
  }
}

/** Current position of a driver (null before they start). */
export function driverPos(d: NetDriver): LatLng | null {
  if (!d.started) return null;
  return pointAt(d.geoms[d.routeIdx], d.s);
}

/** Extra minutes on an alternative from drivers who already rerouted. */
export function detourLoadMin(
  loads: Map<string, number>,
  tripId: string,
  routeIdx: number,
): number {
  return Math.min(
    NET_DETOUR_LOAD_CAP_MIN,
    (loads.get(`${tripId}:${routeIdx}`) ?? 0) * NET_DETOUR_LOAD_MIN,
  );
}

function recordLoad(loads: Map<string, number>, tripId: string, routeIdx: number): void {
  const key = `${tripId}:${routeIdx}`;
  loads.set(key, (loads.get(key) ?? 0) + 1);
}

/**
 * Minutes from now for a driver to reach arclength s on their active route,
 * driving each step at its own speed (same rule as your car).
 */
export function driverMinutesTo(
  d: NetDriver,
  s: number,
  routeIdx?: number,
): number {
  const idx = routeIdx ?? d.routeIdx;
  return projectToSWithSpeeds(d.s, s, [], d.speeds[idx], NET_BASE_MPS) / 60;
}

/** Remaining drive minutes from the driver's position on a route. */
export function driverRemainMin(d: NetDriver, routeIdx: number): number {
  return Math.max(
    0,
    routesRemainSec(d.durationsSec[routeIdx], d.distancesM[routeIdx], d.s) / 60,
  );
}

export interface NotifyCheck {
  notify: boolean;
  incidentS: number;
  arrivalMin: number;
}

/**
 * Notification rule: the incident must be on the driver's ACTIVE route
 * within 300 m, ahead of them, going their way — and they must arrive
 * before it likely clears. Never notifies twice or after arrival.
 */
export function checkNotify(d: NetDriver, incident: NetIncident): NotifyCheck {
  const geom = d.geoms[d.routeIdx];
  const not = { notify: false, incidentS: 0, arrivalMin: 0 };
  if (!d.started || d.arrived || d.notifiedAt !== null) return not;
  if (incident.cleared) return not;
  if (d.direction !== incident.direction) return not;
  const p = { lat: incident.lat, lng: incident.lng };
  if (minDistanceToRoute(geom, p) > 300) return not;
  const snap = nearestOnRoute(geom, p);
  if (snap.s <= d.s) return not;
  const arrivalMin = driverMinutesTo(d, snap.s);
  if (arrivalMin >= incident.clearHiMin) return not;
  return { notify: true, incidentS: snap.s, arrivalMin };
}

/** Mark drivers newly notified at this sim time; returns their ids. */
export function notifyDrivers(
  drivers: NetDriver[],
  incident: NetIncident,
  simSec: number,
): string[] {
  const ids: string[] = [];
  for (const d of drivers) {
    const c = checkNotify(d, incident);
    if (!c.notify) continue;
    d.notifiedAt = simSec;
    d.decideAt = simSec + NET_DECIDE_DELAY_SEC;
    d.incidentS = c.incidentS;
    d.status = 'alerted';
    ids.push(d.id);
  }
  return ids;
}

/**
 * Score Stay / Reroute / Stop & wait for one driver from THEIR position,
 * with the active-plan, no-flip-flop and fewest-delays rules. Times are
 * minutes from now; reroute/stop legs add the current detour load.
 */
export function scoreDriver(
  d: NetDriver,
  incidents: NetIncident[],
  loads: Map<string, number>,
): NetOptions {
  const active = incidents.filter((i) => !i.cleared);
  const geom = d.geoms[d.routeIdx];
  const ahead = active
    .map((i) => {
      if (d.direction !== i.direction) return null;
      if (minDistanceToRoute(geom, { lat: i.lat, lng: i.lng }) > 300) return null;
      const snap = nearestOnRoute(geom, { lat: i.lat, lng: i.lng });
      if (snap.s <= d.s) return null;
      const arrivalMin = driverMinutesTo(d, snap.s);
      if (arrivalMin >= i.clearHiMin) return null;
      return { incident: i, s: snap.s, arrivalMin };
    })
    .filter((x): x is { incident: NetIncident; s: number; arrivalMin: number } => x !== null)
    .sort((a, b) => a.s - b.s);

  const baseRemain = driverRemainMin(d, d.routeIdx);
  let stayMin = baseRemain;
  let shiftMin = 0;
  for (const a of ahead) {
    const tMin = a.arrivalMin + shiftMin;
    const delay = stayDelayRange(
      tMin,
      a.incident.clearLoMin,
      a.incident.clearLikelyMin,
      a.incident.clearHiMin,
      a.incident.lanes,
      a.incident.ageMin,
    ).mid;
    stayMin += delay;
    shiftMin += delay;
  }

  let rerouteMin: number | null = null;
  let rerouteIdx: number | null = null;
  let rerouteAvoidsAll = true;
  for (let i = 0; i < d.geoms.length; i += 1) {
    if (i === d.routeIdx) continue;
    const altGeom = d.geoms[i];
    // Remaining time on the alternative from the equivalent position.
    const pos = pointAt(geom, d.s);
    const altS = nearestOnRoute(altGeom, pos).s;
    let total = Math.max(0, routesRemainSec(d.durationsSec[i], d.distancesM[i], altS) / 60);
    total += detourLoadMin(loads, d.tripId, i);
    let altShift = 0;
    let hits = 0;
    for (const inc of active) {
      if (d.direction !== inc.direction) continue;
      if (minDistanceToRoute(altGeom, { lat: inc.lat, lng: inc.lng }) > 300) continue;
      const s = nearestOnRoute(altGeom, { lat: inc.lat, lng: inc.lng }).s;
      if (s <= altS) continue;
      const tMin = projectToSWithSpeeds(altS, s, [], d.speeds[i], NET_BASE_MPS) / 60 + altShift;
      if (tMin >= inc.clearHiMin) continue;
      const delay = stayDelayRange(
        tMin,
        inc.clearLoMin,
        inc.clearLikelyMin,
        inc.clearHiMin,
        inc.lanes,
        inc.ageMin,
      ).mid;
      total += delay;
      altShift += delay;
      hits += 1;
    }
    if (rerouteMin === null || total < rerouteMin) {
      rerouteMin = total;
      rerouteIdx = i;
      rerouteAvoidsAll = hits === 0;
    }
  }

  let stopMin: number | null = null;
  let stopWaitMin: number | null = null;
  if (ahead.length > 0) {
    const first = ahead[0];
    const stopS = Math.max(0, first.s - 1500);
    const toStopMin = driverMinutesTo(d, stopS);
    const stopToIncidentMin = Math.max(0, first.arrivalMin - toStopMin);
    const stopToDestMin = Math.max(
      0,
      routesRemainSec(d.durationsSec[d.routeIdx], d.distancesM[d.routeIdx], stopS) / 60,
    );
    const est = stopWaitEstimate({
      clearLoMin: first.incident.clearLoMin,
      clearLikelyMin: first.incident.clearLikelyMin,
      clearHiMin: first.incident.clearHiMin,
      toStopMin,
      stopToIncidentMin,
      stopToDestMin,
    });
    if (est) {
      stopMin = est.arrivalMin;
      stopWaitMin = est.waitMin;
    }
  }

  // No flip-flopping: switch only on a real saving.
  const remainMin = Math.max(1, baseRemain);
  const threshold = Math.max(NET_SWITCH_MIN, NET_SWITCH_FRAC * remainMin);
  let best: NetOptions['best'] = 'stay';
  let bestReason: string | null = 'Switching saves under 3 min';
  const savesVsStay = (opt: number | null): number | null =>
    opt === null ? null : stayMin - opt;
  const rerouteSaves = savesVsStay(rerouteMin);
  const stopSaves = savesVsStay(stopMin);
  const bestSaves = Math.max(rerouteSaves ?? -Infinity, stopSaves ?? -Infinity);
  if (bestSaves >= threshold) {
    if ((rerouteSaves ?? -Infinity) >= (stopSaves ?? -Infinity)) {
      best = 'reroute';
    } else {
      best = 'stop';
    }
    bestReason = null;
  } else if (bestSaves <= 0 && rerouteSaves !== null && rerouteSaves <= 0 && (stopSaves === null || stopSaves <= 0)) {
    bestReason = 'Switching saves under 3 min';
  }

  let fewestDelaysReason: string | null = null;
  if (rerouteMin !== null && !rerouteAvoidsAll && best === 'reroute' && rerouteIdx !== null) {
    fewestDelaysReason =
      `Both routes have delays; ${d.routeNames[rerouteIdx]} is shorter.`;
  }
  return {
    stayMin,
    rerouteMin,
    rerouteIdx,
    rerouteAvoidsAll,
    fewestDelaysReason,
    stopMin,
    stopWaitMin,
    best,
    bestReason,
    incidentAhead: ahead.length > 0,
  };
}

/**
 * Decide for every notified driver whose time has come, oldest alert first.
 * Seeded choice model: 75% fastest, 15% stay regardless, 10% stop if offered.
 * Rerouting drivers load their alternative before later drivers score.
 */
export function decideDue(
  drivers: NetDriver[],
  incidents: NetIncident[],
  loads: Map<string, number>,
  simSec: number,
): string[] {
  const due = drivers
    .filter((d) => d.notifiedAt !== null && d.choice === null && (d.decideAt ?? Infinity) <= simSec)
    .sort((a, b) => (a.notifiedAt ?? 0) - (b.notifiedAt ?? 0));
  const decided: string[] = [];
  for (const d of due) {
    const opts = scoreDriver(d, incidents, loads);
    let choice: NetChoice;
    if (!opts.incidentAhead) {
      choice = 'stay';
    } else if (d.choiceRoll < 0.75) {
      choice = opts.best;
    } else if (d.choiceRoll < 0.9) {
      choice = 'stay';
    } else {
      choice = opts.stopMin !== null ? 'stop' : opts.best;
    }
    d.choice = choice;
    if (choice === 'reroute' && opts.rerouteIdx !== null) {
      const pos = pointAt(d.geoms[d.routeIdx], d.s);
      d.routeIdx = opts.rerouteIdx;
      // Keep the car at the equivalent spot on the new route.
      const g = d.geoms[d.routeIdx];
      d.s = Math.min(g.length, nearestOnRoute(g, pos).s);
      d.arrived = d.s >= g.length;
      recordLoad(loads, d.tripId, opts.rerouteIdx);
      d.status = 'rerouted';
      d.savedMin = Math.max(0, opts.stayMin - (opts.rerouteMin ?? opts.stayMin));
    } else if (choice === 'stop') {
      d.status = 'waiting';
      d.savedMin = Math.max(0, opts.stayMin - (opts.stopMin ?? opts.stayMin));
    } else {
      d.status = 'stayed';
      d.savedMin = 0;
    }
    decided.push(d.id);
  }
  return decided;
}

/** Panel counts: notified, rerouted, stayed, waiting, saved, unaffected. */
export function netCounts(drivers: NetDriver[]): NetCounts {
  let notified = 0;
  let rerouted = 0;
  let stayed = 0;
  let waiting = 0;
  let savedDriverMin = 0;
  for (const d of drivers) {
    if (d.notifiedAt === null) continue;
    notified += 1;
    if (d.status === 'rerouted') rerouted += 1;
    else if (d.status === 'stayed') stayed += 1;
    else if (d.status === 'waiting') waiting += 1;
    savedDriverMin += d.savedMin;
  }
  return {
    notified,
    rerouted,
    stayed,
    waiting,
    savedDriverMin,
    unaffected: drivers.length - notified,
  };
}

/** Dot color per driver state for the map overlay. */
export function driverColor(d: NetDriver): string {
  if (!d.started || d.arrived) return '#9ca3af';
  if (d.status === 'alerted') return '#f59e0b';
  if (d.status === 'rerouted') return '#2563eb';
  if (d.status === 'stayed') return '#dc2626';
  if (d.status === 'waiting') return '#9333ea';
  return '#9ca3af';
}
