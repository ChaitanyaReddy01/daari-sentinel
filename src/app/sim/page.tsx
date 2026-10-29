/* eslint-disable @typescript-eslint/no-explicit-any */
// Reason: the Google Maps JS API has no bundled types here (`any` stays at
// the Maps boundary and never leaks into sim math), and thumbnails are plain
// <img> tags served from our own cached API route.
'use client';

import { useEffect, useRef, useState } from 'react';

import { displayClearance, type AgentAssessment } from '@/lib/agent-guard';
import { clipThumbUrl, clipVideoUrl } from '@/lib/clip-urls';
import { clearanceEstimate } from '@/lib/clearance';
import {
  DEMO_EVENTS,
  EXIT27,
  METERS_PER_MILE,
  MPH_TO_MPS,
  buildRouteGeom,
  createCars,
  decodePolyline,
  formatElapsed,
  formatEta,
  haversineMeters,
  nearestOnRoute,
  pointAt,
  speedInZones,
  stageSpeedMps,
  type RouteGeom,
  type SimCar,
  type SlowZone,
} from '@/lib/sim';
import {
  beep,
  buildStepSpeeds,
  decideByLabel,
  findDivergence,
  minDistanceToRoute,
  projectToSWithSpeeds,
  remainingWithSpeeds,
  rerouteDelayMin,
  routeName,
  speak,
  speedAtSpeeds,
  stayDelayRange,
  stopWaitEstimate,
  subPath,
  type StepSpeed,
} from './drive';

const BROWSER_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? '';
const SIM_SEED = 1337;
const YOUR_BASE_MPS = 60 * MPH_TO_MPS;
const SLOW_AHEAD_METERS = 0.5 * METERS_PER_MILE;
const WARN_LATERAL_METERS = 300;
const SPEEDS = [1, 10, 30] as const;
const ROUTE_BLUE = '#1a73e8';
const NEW_HAVEN = { lat: 41.3083, lng: -72.9279 };
/** Pseudo-clip id for incidents imported from /try (video deleted; stills kept in session). */
const TRY_CLIP = 'try-clip';
/** Suggest a switch only past this saving (or 10% of remaining, larger wins). */
const SWITCH_SAVE_MIN = 3;
/** After picking a plan, hold it this long before offering a switch back. */
const PLAN_HOLD_SEC = 120;
/** …unless a new incident or stage change saves this much by switching. */
const HOLD_BREAK_MIN = 5;

interface SimVerdict {
  incident: boolean;
  type: string;
  severity: string | null;
  stage: string;
  lanesBlocked: string;
  responders: { police: boolean; ambulance: boolean; fire: boolean; towTruck: boolean };
  summary: string;
  evidence: { second: number; what: string }[];
}

interface SimReport {
  t: number;
  clip: string;
  stage: string;
  summary: string;
  incident: boolean;
  reportId: string;
  direction: 'same' | 'oncoming';
}

interface TryImport {
  verdict: SimVerdict;
  stored: IncidentAssessment;
  cost: number;
  clipSeconds: number;
  stills: { seconds: number; jpeg: string }[];
}

interface IncidentAssessment {
  assessment: AgentAssessment;
  source: 'muse-wonder' | 'fallback table';
  notes: string[];
  estUSD: number;
  atT: number;
}

interface SimIncident {
  id: number;
  routeIdx: number;
  s: number;
  lat: number;
  lng: number;
  reporterCar: number;
  reports: SimReport[];
  assessments: IncidentAssessment[];
  agentCost: number;
  stage: string;
  severity: string | null;
  lanesBlocked: string;
  active: boolean;
  thumbnail: string | null;
  responders: SimVerdict['responders'];
  summary: string;
  type: string;
}

interface TripStep {
  distanceMeters: number;
  instruction: string | null;
  durationSeconds?: number;
}

interface TripRouteData {
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
  description: string | null;
  steps: TripStep[];
}

interface DriveRoute {
  data: TripRouteData;
  geom: RouteGeom;
  speeds: StepSpeed[];
}

/** The route the driver is committed to. Starts as the trip's main route. */
interface RoutePlan {
  routeId: string;
  idx: number;
  data: TripRouteData;
  geom: RouteGeom;
  speeds: StepSpeed[];
  label: string;
  chosenAt: number;
}

interface Hud {
  simTime: number;
  distLeft: number;
  eta: string;
  arrived: boolean;
}

interface RerouteOption {
  available: boolean;
  reason?: string;
  arrivalClock?: string;
  diffMin?: number;
  altIdx?: number;
  divergeS?: number;
  altS?: number;
  viaName?: string;
  decideLabel?: string;
  decideMin?: number;
  fewestDelays?: boolean;
}

interface StopOption {
  name: string;
  waitMin: number;
  arrivalClock: string;
  arrivalLoClock: string;
  arrivalHiClock: string;
  stopS: number;
  resumeAt: number;
  arrivalS: number;
}

interface WarningOptions {
  stayArrival: string;
  stayLoClock: string;
  stayHiClock: string;
  jamDelayMin: number;
  jamLoMin: number;
  jamHiMin: number;
  mainName: string;
  reroute: RerouteOption;
  stop: StopOption | null;
  fastest: 'stay' | 'reroute' | 'stop';
  switchNote: string | null;
  stayTotalMin: number;
  rerouteTotalMin: number | null;
  stopTotalMin: number | null;
}

interface Choice {
  kind: 'stay' | 'reroute' | 'stop';
  label: string;
  incidentId: number;
}

const TYPE_PIN: Record<string, { letter: string; color: string }> = {
  crash: { letter: 'C', color: '#dc2626' },
  stalled_vehicle: { letter: 'S', color: '#d97706' },
  debris: { letter: 'D', color: '#d97706' },
  flooding: { letter: 'W', color: '#2563eb' },
  fire: { letter: 'F', color: '#ea580c' },
  police_activity: { letter: 'P', color: '#1d4ed8' },
  construction: { letter: 'R', color: '#b45309' },
  none: { letter: '–', color: '#78716c' },
  unknown: { letter: '?', color: '#78716c' },
};

function pretty(value: string): string {
  return value.replace(/_/g, ' ');
}

function fmtUSD(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtMi(meters: number): string {
  return `${(meters / METERS_PER_MILE).toFixed(1)} mi`;
}

function fmtMin(seconds: number): string {
  return `${Math.max(0, Math.round(seconds / 60))} min`;
}

function fmtClock(second: number): string {
  const s = Math.max(0, Math.floor(second));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function reportNumber(reportId: string): string {
  const m = /(\d+)\s*$/.exec(reportId);
  return m ? m[1] : reportId;
}

/** The model sometimes prefixes narrowsIf with "Narrows if" itself. */
function stripNarrowsPrefix(s: string): string {
  return s.replace(/^\s*narrows\s+if\s*:?\s*/i, '');
}

function capFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error) return data.error;
  } catch {
    // Fall through to the status text.
  }
  return `Request failed (${res.status} ${res.statusText})`;
}

let mapsPromise: Promise<void> | null = null;

function loadMapsApi(key: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window.'));
  const w = window as any;
  if (w.google?.maps) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    w.gm_authFailure = () => reject(new Error('Google Maps rejected the browser key.'));
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    script.async = true;
    script.onload = () => {
      if (w.google?.maps) resolve();
      else reject(new Error('Google Maps script loaded but the API is unavailable.'));
    };
    script.onerror = () => reject(new Error('Failed to load the Google Maps script.'));
    document.head.appendChild(script);
  });
  return mapsPromise;
}

/**
 * Three-canvas overlay in the top pane (polylines render above overlayLayer
 * in this Maps build): traffic dots, congestion stretches, then your arrow.
 */
function createCarsOverlay(
  google: any,
  map: any,
  draw: (
    dots: HTMLCanvasElement,
    cong: HTMLCanvasElement,
    arrow: HTMLCanvasElement,
    projection: any,
  ) => void,
): any {
  const overlay = new google.maps.OverlayView();
  const dots = document.createElement('canvas');
  const cong = document.createElement('canvas');
  const arrow = document.createElement('canvas');
  for (const [c, z] of [
    [dots, '1000'],
    [cong, '1001'],
    [arrow, '1002'],
  ] as const) {
    c.style.position = 'absolute';
    c.style.pointerEvents = 'none';
    c.style.zIndex = z;
  }
  overlay.onAdd = () => {
    const pane = overlay.getPanes().floatPane;
    pane.appendChild(dots);
    pane.appendChild(cong);
    pane.appendChild(arrow);
  };
  overlay.draw = () => {
    const projection = overlay.getProjection();
    if (projection) draw(dots, cong, arrow, projection);
  };
  overlay.onRemove = () => {
    dots.remove();
    cong.remove();
    arrow.remove();
  };
  overlay.setMap(map);
  return overlay;
}

interface AutocompleteSuggestion {
  placeId: string;
  label: string;
}

async function fetchAutocomplete(
  input: string,
  bias: { lat: number; lng: number } | null,
): Promise<AutocompleteSuggestion[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': BROWSER_KEY,
    },
    body: JSON.stringify({
      input,
      ...(bias
        ? {
            locationBias: {
              circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 50000.0 },
            },
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Autocomplete failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    suggestions?: Array<{ placePrediction?: { placeId?: string; text?: { text?: string } } }>;
  };
  const out: AutocompleteSuggestion[] = [];
  for (const s of data.suggestions ?? []) {
    const p = s.placePrediction;
    if (p?.placeId && p.text?.text) out.push({ placeId: p.placeId, label: p.text.text });
  }
  return out;
}

interface ModalState {
  mode: 'drop' | 'followup';
  s: number;
  lat: number;
  lng: number;
  routeIdx: number;
  incidentId: number | null;
}

type OriginState =
  | { kind: 'locating' }
  | { kind: 'geo'; lat: number; lng: number }
  | { kind: 'default' };

interface TripPlan {
  originLabel: string;
  destLabel: string;
  destReq: { placeId: string } | { lat: number; lng: number } | { address: string };
  routes: TripRouteData[];
}

export default function SimPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'plan' | 'drive'>('plan');
  const [mapStatus, setMapStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [mapError, setMapError] = useState('');
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(10);
  const [hud, setHud] = useState<Hud>({ simTime: 0, distLeft: 0, eta: '', arrived: false });
  const [incidents, setIncidents] = useState<SimIncident[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [arming, setArming] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [demoOn, setDemoOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [follow, setFollow] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [warnedIds, setWarnedIds] = useState<number[]>([]);
  const [activeIdx, setActiveIdxState] = useState(0);
  const [options, setOptions] = useState<WarningOptions | null>(null);
  const [returnOffer, setReturnOffer] = useState<{
    convAltS: number;
    origS: number;
    saveMin: number;
  } | null>(null);
  const [evidencePlay, setEvidencePlay] = useState<{
    clip: string;
    second: number;
    label: string;
  } | null>(null);

  // Plan-screen state.
  const [origin, setOrigin] = useState<OriginState>({ kind: 'locating' });
  const [toInput, setToInput] = useState('');
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [destPick, setDestPick] = useState<AutocompleteSuggestion | null>(null);
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const mapRef2 = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const routeLineRef = useRef<any>(null);
  const altLineRef = useRef<any>(null);
  const exitMarkerRef = useRef<any>(null);
  const rerouteMsRef = useRef<number | null>(null);
  const markersRef = useRef<any[]>([]);
  const tripRef = useRef<{ routes: DriveRoute[]; originLabel: string; destLabel: string } | null>(null);
  const destReqRef = useRef<TripPlan['destReq'] | null>(null);
  const isDemoRef = useRef(false);
  const carsRef = useRef<SimCar[]>([]);
  const trafficGeomRef = useRef<RouteGeom | null>(null);
  const trafficSpeedsRef = useRef<StepSpeed[]>([]);
  const yourCarRef = useRef({ s: 0, arrived: false });
  const simTimeRef = useRef(0);
  const playingRef = useRef(true);
  const speedRef = useRef<(typeof SPEEDS)[number]>(10);
  const armingRef = useRef(false);
  const followRef = useRef(true);
  const lastPanRef = useRef(0);
  const fitAtRef = useRef(0);
  const mutedRef = useRef(false);
  const incidentsRef = useRef<SimIncident[]>([]);
  const zonesRef = useRef<SlowZone[]>([]);
  const currentIdxRef = useRef(0);
  const pendingSwitchRef = useRef<{ altIdx: number; divergeS: number; altS: number } | null>(null);
  const stopPlanRef = useRef<{ s: number; resumeAt: number; name: string } | null>(null);
  const warnedIdsRef = useRef<number[]>([]);
  const activeIdxRef = useRef(0);
  const planChosenAtRef = useRef(0);
  const candRef = useRef<{ key: string; idxs: number[] } | null>(null);
  const lastPickRef = useRef<{ at: number; planIdx: number } | null>(null);
  const lastChangeRef = useRef(0);
  const returnSaveRef = useRef<number | null>(null);
  const returnThresholdRef = useRef<number | null>(null);
  const optionsTokenRef = useRef(0);
  const demoRef = useRef({ active: false, fired: 0, incidentId: null as number | null });
  const demoChainRef = useRef<Promise<void>>(Promise.resolve());
  const demoAnchorRef = useRef<{ s: number; lat: number; lng: number } | null>(null);
  const tryStillsRef = useRef<{ seconds: number; jpeg: string }[]>([]);
  const autoStartRef = useRef(false);
  const nextIdRef = useRef(1);
  const googleRef = useRef<any>(null);

  const showToast = (message: string) => {
    setToast({ id: Date.now() + Math.random(), message });
  };

  const alert = (message: string, voice?: string) => {
    showToast(message);
    if (mutedRef.current) return;
    beep();
    speak(voice ?? message);
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!evidencePlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEvidencePlay(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [evidencePlay]);

  // Scripted-verification hook (multi-incident scenarios). Read-only except
  // for drop/followUp, which run the same cached paths as the UI.
  useEffect(() => {
    (window as unknown as { __sim?: unknown }).__sim = {
      drop: async (routeIdx: number, s: number, clip: string) => {
        const g = tripRef.current?.routes[routeIdx]?.geom;
        if (!g) return null;
        const sc = Math.min(Math.max(0, s), g.length - 1);
        const pt = pointAt(g, sc);
        const verdict = await runReport(clip);
        if (!verdict) return null;
        return createIncident(
          { s: sc, lat: pt.lat, lng: pt.lng, routeIdx },
          clip,
          verdict,
          simTimeRef.current,
          'same',
        );
      },
      followUp: async (id: number, clip: string) => {
        const verdict = await runReport(clip);
        if (!verdict) return false;
        await applyFollowup(id, clip, verdict, simTimeRef.current, 'same');
        return true;
      },
      recompute: () => {
        void refreshCandidates().then(() => computeOptions());
      },
      stopDemo: () => {
        demoRef.current.active = false;
        setDemoOn(false);
      },
      distToRoutes: (lat: number, lng: number) => {
        const trip = tripRef.current;
        if (!trip) return [];
        return trip.routes.map((r, idx) => ({
          idx,
          d: minDistanceToRoute(r.geom, { lat, lng }),
        }));
      },
      pointAt: (routeIdx: number, s: number) => {
        const g = tripRef.current?.routes[routeIdx]?.geom;
        if (!g) return null;
        return pointAt(g, Math.min(Math.max(0, s), g.length - 1));
      },
      state: () => ({
        simTime: simTimeRef.current,
        activeIdx: activeIdxRef.current,
        activeLabel: activePlan()?.label ?? null,
        carS: activeS(),
        youS: yourCarRef.current.s,
        currentIdx: currentIdxRef.current,
        warnedIds: [...warnedIdsRef.current],
        incidents: incidentsRef.current.map((i) => ({
          id: i.id,
          active: i.active,
          stage: i.stage,
          type: i.type,
          affected: affectedRoutes(i),
        })),
        routes: (tripRef.current?.routes ?? []).map((r, idx) => ({
          idx,
          label: routeName(r.data.description, r.data.steps),
          length: r.geom.length,
        })),
        cands: (candRef.current?.idxs ?? []).map((idx) => {
          const r = tripRef.current?.routes[idx];
          if (!r) return { idx, missing: true };
          const sc = scoreRoute(r, 0, simTimeRef.current);
          const hits = activeIncidents()
            .filter(
              (inc) =>
                incidentSOn(inc, r.geom) > 50 &&
                minDistanceToRoute(r.geom, { lat: inc.lat, lng: inc.lng }) <=
                  WARN_LATERAL_METERS,
            )
            .map((i) => i.id);
          return {
            idx,
            label: routeName(r.data.description, r.data.steps),
            totalMin: Math.round(sc.total / 6) / 10,
            driveMin: Math.round(sc.drive / 6) / 10,
            hits,
          };
        }),
        options: options
          ? {
              fastest: options.fastest,
              stay: `STAY on ${options.mainName}`,
              jamDelayMin: options.jamDelayMin,
              rerouteVia: options.reroute.available ? options.reroute.viaName : null,
              fewestDelays: !!options.reroute.fewestDelays,
              reason: options.reroute.reason ?? null,
              switchNote: options.switchNote,
              stayTotalMin: options.stayTotalMin,
              rerouteTotalMin: options.rerouteTotalMin,
              stopTotalMin: options.stopTotalMin,
            }
          : null,
        choice: choice?.kind ?? null,
        returnOffer: returnOffer ? { saveMin: returnOffer.saveMin } : null,
        returnSave: returnSaveRef.current,
        returnThreshold: returnThresholdRef.current,
      }),
    };
    return () => {
      delete (window as unknown as { __sim?: unknown }).__sim;
    };
  });

  useEffect(() => {
    try {
      setMuted(window.localStorage.getItem('sim-muted') === '1');
    } catch {
      // Private mode: stay unmuted.
    }
  }, []);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    mutedRef.current = muted;
    try {
      window.localStorage.setItem('sim-muted', muted ? '1' : '0');
    } catch {
      // Ignore persistence failures.
    }
    if (muted) {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // Ignore.
      }
    }
  }, [muted]);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  useEffect(() => {
    armingRef.current = arming;
    if (mapRef2.current) {
      mapRef2.current.setOptions({ draggableCursor: arming ? 'crosshair' : null });
    }
  }, [arming]);
  useEffect(() => {
    currentIdxRef.current = currentIdx;
  }, [currentIdx]);
  useEffect(() => {
    incidentsRef.current = incidents;
  }, [incidents]);
  useEffect(() => {
    warnedIdsRef.current = warnedIds;
  }, [warnedIds]);
  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);

  const yourGeom = (): RouteGeom | null => {
    const trip = tripRef.current;
    if (!trip) return null;
    return trip.routes[currentIdxRef.current]?.geom ?? null;
  };

  const yourSpeeds = (): StepSpeed[] => {
    const trip = tripRef.current;
    if (!trip) return [];
    return trip.routes[currentIdxRef.current]?.speeds ?? [];
  };

  /** The committed route plan. Warnings, ETAs, and options use this. */
  const activePlan = (): RoutePlan | null => {
    const trip = tripRef.current;
    const route = trip?.routes[activeIdxRef.current];
    if (!trip || !route) return null;
    return {
      routeId: `route-${activeIdxRef.current}`,
      idx: activeIdxRef.current,
      data: route.data,
      geom: route.geom,
      speeds: route.speeds,
      label: routeName(route.data.description, route.data.steps),
      chosenAt: planChosenAtRef.current,
    };
  };

  const setActivePlan = (idx: number) => {
    activeIdxRef.current = idx;
    planChosenAtRef.current = simTimeRef.current;
    setActiveIdxState(idx);
  };

  /** Car position measured on the active plan (pre-switch: mapped via divergence). */
  const activeS = (): number => {
    const pend = pendingSwitchRef.current;
    const youS = yourCarRef.current.s;
    if (!pend) return youS;
    return Math.max(0, pend.altS + (youS - pend.divergeS));
  };

  const incidentSOn = (incident: SimIncident, geom: RouteGeom): number =>
    nearestOnRoute(geom, { lat: incident.lat, lng: incident.lng }).s;

  /** Route indexes (into trip.routes) passing within 300 m of the incident. */
  const affectedRoutes = (incident: SimIncident): number[] => {
    const trip = tripRef.current;
    if (!trip) return [];
    const pt = { lat: incident.lat, lng: incident.lng };
    const out: number[] = [];
    trip.routes.forEach((r, idx) => {
      if (minDistanceToRoute(r.geom, pt) <= WARN_LATERAL_METERS) out.push(idx);
    });
    return out;
  };

  const activeIncidents = (): SimIncident[] =>
    incidentsRef.current.filter((i) => i.active && i.stage !== 'cleared');

  // Geolocate once for the plan screen; fall back to New Haven.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setOrigin({ kind: 'default' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setOrigin({ kind: 'geo', lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setOrigin({ kind: 'default' }),
      { timeout: 6000, maximumAge: 60000 },
    );
  }, []);

  // Destination autocomplete (browser key, direct to Google).
  useEffect(() => {
    if (phase !== 'plan' || toInput.trim().length < 2 || !BROWSER_KEY) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(() => {
      const bias = origin.kind === 'geo' ? { lat: origin.lat, lng: origin.lng } : NEW_HAVEN;
      void fetchAutocomplete(toInput.trim(), bias)
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 350);
    return () => clearTimeout(t);
  }, [toInput, origin, phase]);

  const originLabel = (): string =>
    origin.kind === 'geo'
      ? `My location (${origin.lat.toFixed(3)}, ${origin.lng.toFixed(3)})`
      : origin.kind === 'default'
        ? 'New Haven, CT'
        : 'Locating…';

  const fetchTrip = async (
    originReq: { lat: number; lng: number } | { address: string },
    destReq: TripPlan['destReq'],
    via?: { lat: number; lng: number },
  ): Promise<TripRouteData[]> => {
    const res = await fetch('/api/sim/trip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: originReq, destination: destReq, ...(via ? { via } : {}) }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { routes: TripRouteData[] };
    if (!Array.isArray(data.routes) || data.routes.length === 0) {
      throw new Error('Trip routing returned no routes.');
    }
    return data.routes;
  };

  const quickTimesSquare = async () => {
    if (!BROWSER_KEY || planBusy) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      const bias = origin.kind === 'geo' ? { lat: origin.lat, lng: origin.lng } : null;
      const list = await fetchAutocomplete('Times Square, New York', bias);
      if (list.length === 0) throw new Error('No suggestion found for Times Square.');
      setDestPick(list[0]);
      setToInput(list[0].label);
      setSuggestions([]);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Suggestion failed.');
    } finally {
      setPlanBusy(false);
    }
  };

  const planTrip = async () => {
    const destLabel = destPick ? destPick.label : toInput.trim();
    if (!destLabel) {
      setPlanError('Enter a destination first.');
      return;
    }
    setPlanBusy(true);
    setPlanError(null);
    try {
      const originReq =
        origin.kind === 'geo' ? { lat: origin.lat, lng: origin.lng } : { address: 'New Haven, CT' };
      const destReq: TripPlan['destReq'] = destPick
        ? { placeId: destPick.placeId }
        : { address: destLabel };
      const routes = await fetchTrip(originReq, destReq);
      setPlan({ originLabel: originLabel(), destLabel, destReq, routes });
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Route failed.');
    } finally {
      setPlanBusy(false);
    }
  };

  const startDrive = (trip: TripPlan, demo: boolean) => {
    const routes: DriveRoute[] = trip.routes.map((data) => {
      const geom = buildRouteGeom(decodePolyline(data.encodedPolyline));
      return { data, geom, speeds: buildStepSpeeds(data.steps, geom.length, YOUR_BASE_MPS) };
    });
    tripRef.current = { routes, originLabel: trip.originLabel, destLabel: trip.destLabel };
    destReqRef.current = trip.destReq;
    isDemoRef.current = demo;
    trafficGeomRef.current = routes[0].geom;
    trafficSpeedsRef.current = routes[0].speeds;
    carsRef.current = createCars(SIM_SEED, routes[0].geom.length);
    yourCarRef.current = { s: 0, arrived: false };
    simTimeRef.current = 0;
    pendingSwitchRef.current = null;
    stopPlanRef.current = null;
    activeIdxRef.current = 0;
    planChosenAtRef.current = 0;
    candRef.current = null;
    lastPickRef.current = null;
    lastChangeRef.current = 0;
    returnSaveRef.current = null;
    returnThresholdRef.current = null;
    setCurrentIdx(0);
    setActiveIdxState(0);
    setIncidents([]);
    setSelectedId(null);
    setChoice(null);
    setWarnedIds([]);
    setOptions(null);
    setReturnOffer(null);
    setPlaying(true);
    setFollow(true);
    demoRef.current = { active: false, fired: 0, incidentId: null };
    demoChainRef.current = Promise.resolve();
    setDemoOn(false);
    if (demo) {
      demoAnchorRef.current = (() => {
        const snap = nearestOnRoute(routes[0].geom, EXIT27);
        return { s: snap.s, lat: snap.point.lat, lng: snap.point.lng };
      })();
      demoRef.current = { active: true, fired: 0, incidentId: null };
      setDemoOn(true);
    }
    setTripId((t) => t + 1);
    setPhase('drive');
  };

  const beginDrive = () => {
    if (plan) startDrive(plan, false);
  };

  const playDemo = async () => {
    if (demoOn) {
      demoRef.current.active = false;
      setDemoOn(false);
      showToast('Demo stopped.');
      return;
    }
    setPlanBusy(true);
    setPlanError(null);
    try {
      const routes = await fetchTrip({ address: 'New Haven, CT' }, { address: 'Times Square, New York, NY' });
      startDrive(
        {
          originLabel: 'New Haven, CT',
          destLabel: 'Times Square, New York, NY',
          destReq: { address: 'Times Square, New York, NY' },
          routes,
        },
        true,
      );
      showToast('Demo started: I-95 Exit 27 scenario.');
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Demo route failed.');
    } finally {
      setPlanBusy(false);
    }
  };

  const [tripId, setTripId] = useState(0);

  // Map init runs when driving starts (the map div only exists in drive mode).
  useEffect(() => {
    if (phase !== 'drive') return;
    if (!BROWSER_KEY) {
      setMapStatus('error');
      setMapError('no-key');
      return;
    }
    setMapStatus('loading');
    let cancelled = false;
    let map: any = null;
    let overlay: any = null;
    let clickListener: any = null;
    let dragListener: any = null;
    let zoomListener: any = null;
    (async () => {
      try {
        await loadMapsApi(BROWSER_KEY);
        if (cancelled) return;
        const google = (window as any).google;
        googleRef.current = google;
        const trip = tripRef.current;
        if (!trip) throw new Error('No trip.');
        map = new google.maps.Map(mapRef.current, {
          center: { lat: 41.23, lng: -73.0 },
          zoom: 9,
          clickableIcons: false,
          gestureHandling: 'greedy',
          zoomControl: true,
          scrollwheel: true,
        });
        mapRef2.current = map;
        routeLineRef.current = new google.maps.Polyline({
          path: trip.routes[0].geom.points,
          strokeColor: ROUTE_BLUE,
          strokeWeight: 5,
          strokeOpacity: 0.95,
          zIndex: 1,
          map,
        });
        const bounds = new google.maps.LatLngBounds();
        for (const p of trip.routes[0].geom.points) bounds.extend(p);
        fitAtRef.current = Date.now();
        map.fitBounds(bounds);
        overlay = createCarsOverlay(google, map, (dots, cong, arrow, projection) => {
          drawScene(dots, cong, arrow, projection);
        });
        overlayRef.current = overlay;
        clickListener = map.addListener('click', (e: any) => {
          if (!armingRef.current) return;
          const geom = yourGeom();
          if (!geom) return;
          const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
          const snap = nearestOnRoute(geom, p);
          setArming(false);
          setModal({
            mode: 'drop',
            s: snap.s,
            lat: snap.point.lat,
            lng: snap.point.lng,
            routeIdx: currentIdxRef.current,
            incidentId: null,
          });
        });
        dragListener = map.addListener('dragstart', () => setFollow(false));
        // Any zoom change while driving is user-initiated (we never zoom
        // ourselves after the initial fit): wheel, pinch, or buttons.
        zoomListener = map.addListener('zoom_changed', () => {
          if (Date.now() - fitAtRef.current > 1500) setFollow(false);
        });
        setMapStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setMapError(err instanceof Error ? err.message : 'Map failed to load.');
          setMapStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      if (clickListener) googleRef.current?.maps?.event?.removeListener(clickListener);
      if (dragListener) googleRef.current?.maps?.event?.removeListener(dragListener);
      if (zoomListener) googleRef.current?.maps?.event?.removeListener(zoomListener);
      if (overlay) overlay.setMap(null);
      if (routeLineRef.current) routeLineRef.current.setMap(null);
      if (altLineRef.current) altLineRef.current.setMap(null);
      if (exitMarkerRef.current) exitMarkerRef.current.setMap(null);
      for (const m of markersRef.current) m.setMap(null);
      markersRef.current = [];
      routeLineRef.current = null;
      altLineRef.current = null;
      exitMarkerRef.current = null;
      mapRef2.current = null;
      overlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Route lines: blue for the current route; while a reroute is pending,
  // the new route draws solid blue, the old one gray dashed, plus an exit
  // marker. Runs synchronously on choice so feedback is instant.
  useEffect(() => {
    const map = mapRef2.current;
    const trip = tripRef.current;
    if (!map || !trip || mapStatus !== 'ready') return;
    const g = trip.routes[currentIdx]?.geom;
    if (!g) return;
    const google = googleRef.current as any;
    if (routeLineRef.current) routeLineRef.current.setMap(null);
    if (altLineRef.current) {
      altLineRef.current.setMap(null);
      altLineRef.current = null;
    }
    if (exitMarkerRef.current) {
      exitMarkerRef.current.setMap(null);
      exitMarkerRef.current = null;
    }
    const pend = pendingSwitchRef.current;
    const alt = pend && choice?.kind === 'reroute' ? trip.routes[pend.altIdx] : null;
    if (alt && pend) {
      routeLineRef.current = new google.maps.Polyline({
        path: g.points,
        strokeOpacity: 0,
        icons: [
          {
            icon: {
              path: 'M 0,-1 0,1',
              strokeOpacity: 1,
              strokeColor: '#9ca3af',
              strokeWeight: 5,
              scale: 2,
            },
            offset: '0',
            repeat: '14px',
          },
        ],
        zIndex: 1,
        map,
      });
      altLineRef.current = new google.maps.Polyline({
        path: alt.geom.points,
        strokeColor: ROUTE_BLUE,
        strokeWeight: 5,
        strokeOpacity: 0.95,
        zIndex: 2,
        map,
      });
      const returning = choice?.incidentId === -1;
      exitMarkerRef.current = new google.maps.Marker({
        position: pointAt(g, pend.divergeS),
        map,
        title: returning ? 'Merge here' : 'Exit here',
        label: {
          text: returning ? 'Merge here' : 'Exit here',
          color: '#1a73e8',
          fontWeight: 'bold',
        },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#1a73e8',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      return;
    }
    routeLineRef.current = new google.maps.Polyline({
      path: g.points,
      strokeColor: ROUTE_BLUE,
      strokeWeight: 5,
      strokeOpacity: 0.95,
      zIndex: 1,
      map,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, currentIdx, choice, mapStatus]);

  const drawScene = (
    dots: HTMLCanvasElement,
    cong: HTMLCanvasElement,
    arrow: HTMLCanvasElement,
    projection: any,
  ) => {
    const traffic = trafficGeomRef.current;
    const yours = yourGeom();
    const container = mapRef.current;
    if (!traffic || !yours || !container || !googleRef.current) return;
    const google = googleRef.current;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Align the canvases to the map div: the pane origin sits off-corner, so
    // measure it instead of assuming top:0/left:0.
    const pane = dots.parentElement;
    const dx = pane ? container.getBoundingClientRect().left - pane.getBoundingClientRect().left : 0;
    const dy = pane ? container.getBoundingClientRect().top - pane.getBoundingClientRect().top : 0;
    for (const c of [dots, cong, arrow]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
      c.style.left = `${dx}px`;
      c.style.top = `${dy}px`;
    }
    // Container pixels: verified against this Maps build, whose
    // fromLatLngToDivPixel returns center-relative garbage.
    const toPx = (p: { lat: number; lng: number }) =>
      projection.fromLatLngToContainerPixel(new google.maps.LatLng(p.lat, p.lng));
    // Background traffic: small gray dots over the blue line, under congestion.
    const dctx = dots.getContext('2d');
    if (dctx) {
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dctx.clearRect(0, 0, w, h);
      dctx.fillStyle = '#9ca3af';
      for (const car of carsRef.current) {
        const px = toPx(pointAt(traffic, car.s));
        if (!px) continue;
        dctx.beginPath();
        dctx.arc(px.x, px.y, 4, 0, Math.PI * 2);
        dctx.fill();
      }
    }
    // Congestion: slowed stretches only, over the dots.
    const cctx = cong.getContext('2d');
    if (cctx) {
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cctx.clearRect(0, 0, w, h);
      cctx.lineWidth = 7;
      cctx.lineJoin = 'round';
      cctx.lineCap = 'round';
      for (const z of zonesRef.current) {
        const mph = z.mps / MPH_TO_MPS;
        if (mph > 35) continue;
        cctx.strokeStyle = mph < 15 ? 'rgba(220,38,38,0.85)' : 'rgba(245,158,11,0.85)';
        cctx.beginPath();
        subPath(yours, Math.max(0, z.s0), z.s1).forEach((p, i) => {
          const px = toPx(p);
          if (!px) return;
          if (i === 0) cctx.moveTo(px.x, px.y);
          else cctx.lineTo(px.x, px.y);
        });
        cctx.stroke();
      }
    }
    // Your car: blue arrow in the direction of travel, always on top.
    const actx = arrow.getContext('2d');
    if (!actx) return;
    actx.setTransform(dpr, 0, 0, dpr, 0, 0);
    actx.clearRect(0, 0, w, h);
    const you = yourCarRef.current;
    const p0 = pointAt(yours, you.s);
    const p1 = pointAt(yours, Math.min(yours.length, you.s + 40));
    const a = toPx(p0);
    const b = toPx(p1);
    if (a && b) {
      const angle = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
      actx.save();
      actx.translate(a.x, a.y);
      actx.rotate(angle);
      actx.beginPath();
      actx.moveTo(0, -11);
      actx.lineTo(7, 8);
      actx.lineTo(0, 4);
      actx.lineTo(-7, 8);
      actx.closePath();
      actx.fillStyle = ROUTE_BLUE;
      actx.fill();
      actx.lineWidth = 2;
      actx.strokeStyle = '#ffffff';
      actx.stroke();
      actx.restore();
      actx.font = 'bold 11px system-ui, sans-serif';
      const label = 'You';
      const tw = actx.measureText(label).width;
      actx.fillStyle = 'rgba(0,0,0,0.75)';
      actx.fillRect(a.x + 12, a.y - 20, tw + 8, 17);
      actx.fillStyle = '#ffffff';
      actx.fillText(label, a.x + 16, a.y - 7);
    }
  };

  const zonesForRoute = (routeIdx: number): SlowZone[] => {
    const g = tripRef.current?.routes[routeIdx]?.geom;
    if (!g) return [];
    return activeIncidents().flatMap((i) => {
      if (minDistanceToRoute(g, { lat: i.lat, lng: i.lng }) > WARN_LATERAL_METERS) return [];
      const s = incidentSOn(i, g);
      const mph = stageSpeedMps(i.stage);
      if (mph === null) return [];
      return [{ s0: s - SLOW_AHEAD_METERS, s1: s, mps: mph * MPH_TO_MPS }];
    });
  };

  // ---- multi-incident route scoring (seconds) ----
  interface RouteScore {
    drive: number;
    lo: number;
    mid: number;
    hi: number;
    total: number;
    totalLo: number;
    totalHi: number;
  }

  /** An incident's clearance range remaining now, else the planning table. */
  const incidentRangeAt = (
    inc: SimIncident,
    simNow: number,
  ): { lo: number; likely: number; hi: number } => {
    const latest = inc.assessments[inc.assessments.length - 1] ?? null;
    if (latest) {
      const rem = displayClearance(
        latest.assessment,
        (simNow - latest.atT) / 60,
        inc.reports.some((r) => !r.incident),
      );
      return { lo: rem.lowMin, likely: rem.likelyMin, hi: rem.highMin };
    }
    const clear = clearanceEstimate(inc.type, inc.stage, inc.severity);
    if (clear.loMin === null || clear.likelyMin === null || clear.hiMin === null) {
      return { lo: 0, likely: 0, hi: 0 };
    }
    return { lo: clear.loMin, likely: clear.likelyMin, hi: clear.hiMin };
  };

  /**
   * Score a route from fromS: free-flow drive time plus per-incident delays
   * in reach order, each evaluated at its arrival time after earlier delays.
   * startOffsetSec shifts arrivals when scoring a leg reached later (e.g. a
   * reroute's remainder after the drive to the divergence point).
   */
  const scoreRoute = (
    route: { geom: RouteGeom; speeds: StepSpeed[] },
    fromS: number,
    simNow: number,
    startOffsetSec = 0,
  ): RouteScore => {
    const base = YOUR_BASE_MPS;
    const drive = remainingWithSpeeds(fromS, route.speeds, base, route.geom.length);
    const onRoute = activeIncidents()
      .map((inc) => ({ inc, s: incidentSOn(inc, route.geom) }))
      .filter(
        (o) =>
          o.s > fromS + 50 &&
          minDistanceToRoute(route.geom, { lat: o.inc.lat, lng: o.inc.lng }) <=
            WARN_LATERAL_METERS,
      )
      .sort((a, b) => a.s - b.s);
    let acc = 0;
    let lo = 0;
    let mid = 0;
    let hi = 0;
    for (const { inc, s } of onRoute) {
      const freeTo = projectToSWithSpeeds(fromS, s, [], route.speeds, base);
      const arrivalMin = (startOffsetSec + freeTo + acc) / 60;
      const c = incidentRangeAt(inc, simNow);
      const ageMin = Math.max(0, (simNow - inc.reports[0].t) / 60 + arrivalMin);
      const r = stayDelayRange(
        arrivalMin,
        c.lo,
        c.likely,
        c.hi,
        inc.lanesBlocked ?? 'unknown',
        ageMin,
      );
      lo += r.lo * 60;
      mid += r.mid * 60;
      hi += r.hi * 60;
      acc += r.mid * 60;
    }
    return { drive, lo, mid, hi, total: drive + mid, totalLo: drive + lo, totalHi: drive + hi };
  };

  // Sim loop: advance traffic on the sim clock, redraw the car canvas.
  useEffect(() => {
    if (phase !== 'drive') return;
    let raf = 0;
    let last = performance.now();
    let uiAcc = 1;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dtReal = Math.min(0.1, (now - last) / 1000);
      last = now;
      const yours = yourGeom();
      const traffic = trafficGeomRef.current;
      if (!yours || !traffic) return;
      if (playingRef.current) {
        const dt = dtReal * speedRef.current;
        simTimeRef.current += dt;
        const demo = demoRef.current;
        while (
          demo.active &&
          demo.fired < DEMO_EVENTS.length &&
          simTimeRef.current >= DEMO_EVENTS[demo.fired].atMin * 60
        ) {
          const idx = demo.fired;
          demo.fired += 1;
          demoChainRef.current = demoChainRef.current.then(() => runDemoEvent(idx)).catch(() => {});
          void demoChainRef.current;
        }
        const trafficZones = zonesForRoute(0);
        const tSpeeds = trafficSpeedsRef.current;
        for (const car of carsRef.current) {
          const base = speedAtSpeeds(tSpeeds, car.s, car.baseMps);
          const v = car.dir === 1 ? speedInZones(base, car.s, trafficZones) : base;
          car.s += car.dir * v * dt;
          if (car.s >= traffic.length) car.s -= traffic.length;
          if (car.s < 0) car.s += traffic.length;
        }
        const yourZones = zonesForRoute(currentIdxRef.current);
        zonesRef.current = yourZones;
        const you = yourCarRef.current;
        if (!you.arrived) {
          const stop = stopPlanRef.current;
          if (stop && activeS() >= stop.s) {
            if (simTimeRef.current >= stop.resumeAt) stopPlanRef.current = null;
          } else {
            const base = speedAtSpeeds(yourSpeeds(), you.s, YOUR_BASE_MPS);
            you.s += speedInZones(base, you.s, yourZones) * dt;
            if (you.s >= yours.length) {
              you.s = yours.length;
              you.arrived = true;
            }
          }
          const pend = pendingSwitchRef.current;
          const trip = tripRef.current;
          if (pend && trip && you.s >= pend.divergeS) {
            const over = you.s - pend.divergeS;
            setCurrentIdx(pend.altIdx);
            yourCarRef.current = { s: pend.altS + over, arrived: false };
            pendingSwitchRef.current = null;
          }
        }
      }
      if (overlayRef.current) overlayRef.current.draw();
      const map = mapRef2.current;
      // Follow mode only pans, at most once per second. Never zoom or fit.
      if (
        map &&
        followRef.current &&
        !yourCarRef.current.arrived &&
        now - lastPanRef.current >= 1000
      ) {
        lastPanRef.current = now;
        const yp = pointAt(yours, yourCarRef.current.s);
        map.panTo({ lat: yp.lat, lng: yp.lng });
      }
      uiAcc += dtReal;
      if (uiAcc >= 0.25) {
        uiAcc = 0;
        zonesRef.current = zonesForRoute(currentIdxRef.current);
        const you = yourCarRef.current;
        const plan = activePlan();
        if (plan) {
          const aS = activeS();
          const score = scoreRoute(plan, aS, simTimeRef.current);
          let etaS = score.total;
          const stop = stopPlanRef.current;
          if (stop && !you.arrived) {
            if (aS >= stop.s) {
              etaS =
                Math.max(0, stop.resumeAt - simTimeRef.current) +
                remainingWithSpeeds(aS, plan.speeds, YOUR_BASE_MPS, plan.geom.length);
            } else {
              const driveT = projectToSWithSpeeds(aS, stop.s, [], plan.speeds, YOUR_BASE_MPS);
              etaS =
                driveT +
                Math.max(0, stop.resumeAt - (simTimeRef.current + driveT)) +
                remainingWithSpeeds(stop.s, plan.speeds, YOUR_BASE_MPS, plan.geom.length);
            }
          }
          setHud({
            simTime: simTimeRef.current,
            distLeft: Math.max(0, (plan.geom.length - aS) / METERS_PER_MILE),
            eta: you.arrived ? 'Arrived' : formatEta(simTimeRef.current, etaS),
            arrived: you.arrived,
          });
        }
        evalWarning();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Pins: warned incidents get type colors; everything else is small gray.
  useEffect(() => {
    const google = googleRef.current;
    const map = mapRef2.current;
    if (!google || !map || mapStatus !== 'ready') return;
    for (const m of markersRef.current) m.setMap(null);
    markersRef.current = incidents.map((i) => {
      const warned = warnedIds.includes(i.id);
      const st = TYPE_PIN[i.type] ?? TYPE_PIN.unknown;
      const marker = new google.maps.Marker({
        position: { lat: i.lat, lng: i.lng },
        map,
        title: i.summary,
        ...(warned ? { label: { text: st.letter, color: '#ffffff', fontWeight: 'bold' } } : {}),
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: warned ? (i.id === selectedId ? 14 : 11) : 8,
          fillColor: warned ? st.color : '#78716c',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      marker.addListener('click', () => setSelectedId(i.id));
      return marker;
    });
  }, [incidents, selectedId, warnedIds, mapStatus]);

  const closestCarId = (lat: number, lng: number, dir?: 1 | -1): number => {
    const traffic = trafficGeomRef.current;
    let best = 0;
    let bestD = Infinity;
    for (const c of carsRef.current) {
      if (!traffic) break;
      if (dir !== undefined && c.dir !== dir) continue;
      const d = haversineMeters(pointAt(traffic, c.s), { lat, lng });
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  };

  const requestAssessment = async (
    reports: SimReport[],
    previous: AgentAssessment | null,
  ): Promise<IncidentAssessment | null> => {
    try {
      const res = await fetch('/api/sim/assess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reports: reports.map((r) => ({
            reportId: r.reportId,
            clip: r.clip,
            direction: r.direction,
            t: r.t,
          })),
          previousAssessment: previous,
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        stored: {
          assessment: AgentAssessment;
          source: 'muse-wonder' | 'fallback table';
          notes: string[];
          estUSD: number;
        };
      };
      return { ...data.stored, atT: simTimeRef.current };
    } catch {
      return null;
    }
  };

  /** Routes from the car's current position, keyed by rounded pos + dest + incidents. */
  const refreshCandidates = async (): Promise<number[]> => {
    const trip = tripRef.current;
    const destReq = destReqRef.current;
    const geom = yourGeom();
    if (!trip || !destReq || !geom) return candRef.current?.idxs ?? [];
    const pos = pointAt(geom, yourCarRef.current.s);
    const rlat = Math.round(pos.lat * 1000) / 1000;
    const rlng = Math.round(pos.lng * 1000) / 1000;
    const key = `${rlat},${rlng}|${JSON.stringify(destReq)}|${activeIncidents()
      .map((i) => i.id)
      .sort((a, b) => a - b)
      .join(',')}`;
    if (candRef.current?.key === key) return candRef.current.idxs;
    try {
      const datas = await fetchTrip({ lat: rlat, lng: rlng }, destReq);
      const idxs: number[] = [];
      for (const data of datas) {
        const dup = trip.routes.findIndex(
          (r) => r.data.encodedPolyline === data.encodedPolyline,
        );
        if (dup >= 0) {
          idxs.push(dup);
          continue;
        }
        const g = buildRouteGeom(decodePolyline(data.encodedPolyline));
        trip.routes.push({
          data,
          geom: g,
          speeds: buildStepSpeeds(data.steps, g.length, YOUR_BASE_MPS),
        });
        idxs.push(trip.routes.length - 1);
      }
      candRef.current = { key, idxs };
      return idxs;
    } catch {
      return candRef.current?.idxs ?? [];
    }
  };

  /** True when a candidate is basically the same road as the plan. */
  const overlapsPlan = (candGeom: RouteGeom, planGeom: RouteGeom): boolean => {
    const n = candGeom.points.length;
    if (n === 0) return false;
    const stride = Math.max(1, Math.floor(n / 40));
    let near = 0;
    let total = 0;
    for (let i = 0; i < n; i += stride) {
      total += 1;
      if (minDistanceToRoute(planGeom, candGeom.points[i]) <= 100) near += 1;
    }
    return total > 0 && near / total > 0.8;
  };

  const createIncident = async (
    point: { s: number; lat: number; lng: number; routeIdx: number },
    clip: string,
    verdict: SimVerdict,
    t: number,
    direction: 'same' | 'oncoming' = 'same',
    opts?: { preAssessed?: IncidentAssessment | null; thumbnail?: string | null; agentCost?: number },
  ): Promise<number | null> => {
    if (!verdict.incident) {
      showToast('Report checked: no incident');
      return null;
    }
    const id = nextIdRef.current++;
    const first = verdict.evidence[0];
    const report: SimReport = {
      t,
      clip,
      stage: verdict.stage,
      summary: verdict.summary,
      incident: verdict.incident,
      reportId: 'r1',
      direction,
    };
    const reporterCar = closestCarId(point.lat, point.lng, direction === 'oncoming' ? -1 : 1);
    const assessed = opts?.preAssessed ?? (await requestAssessment([report], null));
    const stage = assessed ? assessed.assessment.stage : verdict.stage;
    const inc: SimIncident = {
      id,
      routeIdx: point.routeIdx,
      s: point.s,
      lat: point.lat,
      lng: point.lng,
      reporterCar,
      reports: [report],
      assessments: assessed ? [assessed] : [],
      agentCost: opts?.agentCost ?? (assessed ? assessed.estUSD : 0),
      stage,
      severity: verdict.severity,
      lanesBlocked: assessed ? assessed.assessment.lanes.blocked : (verdict.lanesBlocked ?? 'unknown'),
      active: stage !== 'cleared',
      thumbnail:
        opts?.thumbnail ?? (first !== undefined ? clipThumbUrl(clip, first.second) : null),
      responders: verdict.responders,
      summary: verdict.summary,
      type: verdict.type,
    };
    setIncidents((prev) => [...prev, inc]);
    incidentsRef.current = [...incidentsRef.current, inc];
    setSelectedId(id);
    lastChangeRef.current = t;
    // New incidents change alternative scoring even when they are not warned.
    void refreshCandidates().then(() => {
      if (warnedIdsRef.current.length > 0) computeOptions();
    });
    return id;
  };

  const applyFollowup = async (
    incidentId: number,
    clip: string,
    verdict: SimVerdict,
    t: number,
    direction: 'same' | 'oncoming' = 'same',
  ) => {
    const prev = incidentsRef.current.find((i) => i.id === incidentId);
    if (!prev) return;
    const report: SimReport = {
      t,
      clip,
      stage: verdict.stage,
      summary: verdict.summary,
      incident: verdict.incident,
      reportId: `r${prev.reports.length + 1}`,
      direction,
    };
    const reports = [...prev.reports, report];
    const lastAssessment = prev.assessments[prev.assessments.length - 1] ?? null;
    const assessed = await requestAssessment(
      reports,
      lastAssessment ? lastAssessment.assessment : null,
    );
    const stage = assessed
      ? assessed.assessment.stage
      : !verdict.incident || verdict.stage === 'cleared'
        ? 'cleared'
        : verdict.stage;
    const cleared = stage === 'cleared';
    const next: SimIncident = {
      ...prev,
      reports,
      assessments: assessed ? [...prev.assessments, assessed] : prev.assessments,
      agentCost: prev.agentCost + (assessed ? assessed.estUSD : 0),
      stage,
      severity: verdict.severity,
      lanesBlocked: assessed ? assessed.assessment.lanes.blocked : (verdict.lanesBlocked ?? 'unknown'),
      active: !cleared,
      summary: verdict.summary,
      type: verdict.type,
      responders: verdict.responders,
    };
    setIncidents((list) => list.map((i) => (i.id === incidentId ? next : i)));
    incidentsRef.current = incidentsRef.current.map((i) => (i.id === incidentId ? next : i));
    setSelectedId(incidentId);
    if (cleared) {
      handleCleared(next);
      return;
    }
    if (next.stage !== prev.stage) lastChangeRef.current = t;
    if (warnedIdsRef.current.length > 0) {
      const warnedSelf = warnedIdsRef.current.includes(incidentId);
      if (assessed && warnedSelf && next.stage !== prev.stage) {
        const c = assessed.assessment.clearance;
        const range = `clears in ${Math.round(c.lowMin)}–${Math.round(c.highMin)} min`;
        alert(
          `Updated: ${pretty(next.stage)}, ${range}`,
          `Updated. ${pretty(next.stage)}, ${range}.`,
        );
      } else if (!assessed && warnedSelf && next.stage !== prev.stage) {
        const clear = clearanceEstimate(next.type, next.stage, next.severity);
        const range =
          clear.loMin !== null && clear.hiMin !== null
            ? `clears in ${clear.loMin}–${clear.hiMin} min`
            : 'work zone, ongoing';
        alert(
          `Updated: ${pretty(next.stage)}, ${range}`,
          `Updated. ${pretty(next.stage)}, ${range}.`,
        );
      }
      void refreshCandidates().then(() => computeOptions());
    }
  };

  const handleCleared = (incident: SimIncident) => {
    lastChangeRef.current = simTimeRef.current;
    warnedIdsRef.current = warnedIdsRef.current.filter((id) => id !== incident.id);
    setWarnedIds(warnedIdsRef.current);
    setOptions(null);
    setChoice(null);
    alert('Road clear', 'Road clear.');
    // Re-score: if the original route is now faster by the threshold, and no
    // warning is showing, offer the way back (scored with live incidents).
    const trip = tripRef.current;
    const curIdx = currentIdxRef.current;
    returnSaveRef.current = null;
    returnThresholdRef.current = null;
    if (!trip || curIdx === 0) {
      void refreshCandidates().then(() => computeOptions());
      return;
    }
    const cur = trip.routes[curIdx];
    const orig = trip.routes[0];
    const youS = yourCarRef.current.s;
    const simNow = simTimeRef.current;
    // Closest approach back to the original road ahead of the car.
    let conv: { altS: number; origS: number } | null = null;
    let convD = Infinity;
    for (let i = 0; i < cur.geom.points.length; i++) {
      const s = cur.geom.cum[i];
      if (s <= youS) continue;
      const d = minDistanceToRoute(orig.geom, cur.geom.points[i]);
      if (d < convD) {
        convD = d;
        conv = { altS: s, origS: nearestOnRoute(orig.geom, cur.geom.points[i]).s };
      }
    }
    if (convD > WARN_LATERAL_METERS) conv = null;
    void refreshCandidates().then(() => computeOptions());
    if (!conv) return;
    const planRoute = trip.routes[activeIdxRef.current] ?? cur;
    const stayScore = scoreRoute(planRoute, activeS(), simNow);
    const toConv = projectToSWithSpeeds(youS, conv.altS, [], cur.speeds, YOUR_BASE_MPS);
    const backScore = scoreRoute(orig, conv.origS, simNow, toConv);
    const saveMin = (stayScore.total - (toConv + backScore.total)) / 60;
    const thresholdMin = Math.max(SWITCH_SAVE_MIN, (stayScore.total / 60) * 0.1);
    returnSaveRef.current = saveMin;
    returnThresholdRef.current = thresholdMin;
    if (saveMin >= thresholdMin) {
      setReturnOffer({ convAltS: conv.altS, origS: conv.origS, saveMin });
    }
  };

  const evalWarning = () => {
    const plan = activePlan();
    if (!plan) return;
    const aS = activeS();
    const ahead = activeIncidents()
      .map((i) => ({ i, s: incidentSOn(i, plan.geom) }))
      .filter(
        (o) =>
          o.s > aS + 1 &&
          minDistanceToRoute(plan.geom, { lat: o.i.lat, lng: o.i.lng }) <= WARN_LATERAL_METERS,
      )
      .sort((a, b) => a.s - b.s)
      .map((o) => o.i);
    const ids = ahead.map((i) => i.id);
    const prev = warnedIdsRef.current;
    if (ids.length === prev.length && ids.every((id, k) => id === prev[k])) return;
    const fresh = ahead.filter((i) => !prev.includes(i.id));
    warnedIdsRef.current = ids;
    setWarnedIds(ids);
    if (fresh.length > 0) {
      setReturnOffer(null);
      alert(`Traffic alert: ${fresh[0].summary}`, `Traffic alert. ${fresh[0].summary}`);
      // Prefetch: reroute geometry, stops, and switch data load now, so the
      // option buttons never fetch on click.
      void refreshCandidates().then(() => computeOptions());
    } else if (ids.length === 0) {
      setOptions(null);
      if (!pendingSwitchRef.current) setChoice(null);
    } else {
      void computeOptions();
    }
  };

  const computeOptions = async () => {
    const token = ++optionsTokenRef.current;
    const trip = tripRef.current;
    const plan = activePlan();
    if (!trip || !plan) return;
    const warned = warnedIdsRef.current
      .map((id) => incidentsRef.current.find((i) => i.id === id))
      .filter((i): i is SimIncident => !!i && i.active && i.stage !== 'cleared');
    if (warned.length === 0) return;
    const simNow = simTimeRef.current;
    const base = YOUR_BASE_MPS;
    const aS = activeS();
    const zones = zonesForRoute(plan.idx);

    // STAY = the active plan's score: total delay across all incidents on it.
    const stay = scoreRoute(plan, aS, simNow);
    const jamDelayMin = stay.mid / 60;
    const jamLoMin = stay.lo / 60;
    const jamHiMin = stay.hi / 60;
    const stayArrival = formatEta(simNow, stay.total);
    const stayLoClock = formatEta(simNow, stay.totalLo);
    const stayHiClock = formatEta(simNow, stay.totalHi);
    const mainName = plan.label;
    let fastest: 'stay' | 'reroute' | 'stop' = 'stay';
    let bestS = stay.total;
    let switchNote: string | null = null;

    // Nearest warned incident on the plan anchors divergence + decide-by.
    const withS = warned
      .map((i) => ({ i, s: incidentSOn(i, plan.geom) }))
      .sort((a, b) => a.s - b.s);
    const nS = withS[0].s;
    const tMin = projectToSWithSpeeds(aS, nS, zones, plan.speeds, base) / 60;
    const timeToIncidentSec = tMin * 60;

    // REROUTE: score candidates from the divergence point. Prefer one that
    // avoids every active incident; otherwise take the lowest total and say
    // so ("fewest delays"). The pool is prefetched from-position routes plus
    // the trip's own alternatives, so a usable road is always considered.
    const candIdxs = await refreshCandidates();
    if (token !== optionsTokenRef.current) return;
    const poolIdxs = Array.from(
      new Set([...candIdxs, ...trip.routes.map((_, i) => i)]),
    ).filter((i) => i !== plan.idx);
    const actives = activeIncidents();
    const NO_EXIT = 'No exit before the incident: reroute isn\u2019t possible from here';
    let reroute: RerouteOption = { available: false, reason: 'No avoiding route found.' };
    let bestAlt: {
      altIdx: number;
      divergeS: number;
      altS: number;
      totalSec: number;
      toDivSec: number;
      altDriveSec: number;
      avoids: boolean;
    } | null = null;
    let sawExitFailure = false;
    for (const idx of poolIdxs) {
      const route = trip.routes[idx];
      if (!route || overlapsPlan(route.geom, plan.geom)) continue;
      const div = findDivergence(plan.geom, route.geom.points, nS, 50);
      if (!div || div.s <= aS) continue;
      let use = { divergeS: div.s, altS: div.altS };
      let toDiv = projectToSWithSpeeds(aS, use.divergeS, zones, plan.speeds, base);
      if (!(use.divergeS < nS && toDiv < timeToIncidentSec)) {
        const div2 = findDivergence(
          plan.geom,
          route.geom.points,
          Math.min(nS, use.divergeS),
          50,
        );
        if (div2 && div2.s > aS && div2.s < nS) {
          use = { divergeS: div2.s, altS: div2.altS };
          toDiv = projectToSWithSpeeds(aS, use.divergeS, zones, plan.speeds, base);
        }
      }
      if (!(use.divergeS < nS && toDiv < timeToIncidentSec)) {
        sawExitFailure = true;
        continue;
      }
      const rem = scoreRoute(route, use.altS, simNow, toDiv);
      const hits = actives.some(
        (inc) =>
          incidentSOn(inc, route.geom) > use.altS + 50 &&
          minDistanceToRoute(route.geom, { lat: inc.lat, lng: inc.lng }) <= WARN_LATERAL_METERS,
      );
      const total = toDiv + rem.total;
      const cand = {
        altIdx: idx,
        divergeS: use.divergeS,
        altS: use.altS,
        totalSec: total,
        toDivSec: toDiv,
        altDriveSec: rem.drive,
        avoids: !hits,
      };
      if (
        !bestAlt ||
        (cand.avoids && !bestAlt.avoids) ||
        (cand.avoids === bestAlt.avoids && cand.totalSec < bestAlt.totalSec)
      ) {
        bestAlt = cand;
      }
    }
    if (!bestAlt && sawExitFailure) {
      reroute = { available: false, reason: NO_EXIT };
    }
    if (bestAlt) {
      const altData = trip.routes[bestAlt.altIdx].data;
      const decideLabel =
        decideByLabel(altData.steps, bestAlt.altS) ??
        `in ${fmtMi(Math.max(0, bestAlt.divergeS - aS))}`;
      const viaName = routeName(altData.description, altData.steps);
      const saveSec = stay.total - bestAlt.totalSec;
      const thresholdSec = Math.max(SWITCH_SAVE_MIN * 60, stay.total * 0.1);
      let suggest = saveSec >= thresholdSec;
      const pick = lastPickRef.current;
      const changedSincePick = pick !== null && lastChangeRef.current > pick.at;
      if (
        pick !== null &&
        simNow - pick.at < PLAN_HOLD_SEC &&
        !(changedSincePick && saveSec >= HOLD_BREAK_MIN * 60)
      ) {
        suggest = false;
        switchNote = `Holding your route for ${Math.max(1, Math.ceil(PLAN_HOLD_SEC - (simNow - pick.at)))} s`;
      } else if (!suggest) {
        switchNote =
          saveSec < SWITCH_SAVE_MIN * 60
            ? 'Switching saves under 3 min'
            : `Switching saves only ${Math.round(saveSec / 60)} min`;
      }
      reroute = {
        available: true,
        arrivalClock: formatEta(simNow, bestAlt.totalSec),
        diffMin: rerouteDelayMin(bestAlt.toDivSec, bestAlt.altDriveSec, stay.drive),
        altIdx: bestAlt.altIdx,
        divergeS: bestAlt.divergeS,
        altS: bestAlt.altS,
        viaName,
        decideLabel,
        decideMin: bestAlt.toDivSec / 60,
        fewestDelays: !bestAlt.avoids,
        reason: bestAlt.avoids
          ? undefined
          : `Every route has incidents; ${viaName} has the shortest delay`,
      };
      if (suggest && bestAlt.totalSec < bestS) {
        bestS = bestAlt.totalSec;
        fastest = 'reroute';
      }
    }

    // STOP: nearest gas/rest/coffee between you and the decision point, using
    // the total plan delay. Hidden when the nearest incident clears first.
    let stop: StopOption | null = null;
    const nearestHigh = incidentRangeAt(withS[0].i, simNow).hi;
    if (tMin < nearestHigh) {
      const farBound =
        reroute.available && reroute.divergeS !== undefined ? reroute.divergeS : nS;
      if (farBound > aS + 50) {
        const mid = pointAt(plan.geom, (aS + farBound) / 2);
        try {
          const res = await fetch(`/api/sim/stops?lat=${mid.lat}&lng=${mid.lng}`);
          if (res.ok) {
            const data = (await res.json()) as {
              stops: { name: string; lat: number; lng: number }[];
            };
            let pickStop: { name: string; s: number; d: number } | null = null;
            for (const st of data.stops) {
              const snap = nearestOnRoute(plan.geom, st);
              const d = haversineMeters(snap.point, st);
              if (d > 1000 || snap.s <= aS || snap.s >= farBound) continue;
              if (!pickStop || d < pickStop.d) pickStop = { name: st.name, s: snap.s, d };
            }
            if (pickStop) {
              const driveT = projectToSWithSpeeds(aS, pickStop.s, zones, plan.speeds, base);
              const c = incidentRangeAt(withS[0].i, simNow);
              const est = stopWaitEstimate({
                clearLoMin: c.lo,
                clearLikelyMin: c.likely,
                clearHiMin: c.hi,
                toStopMin: driveT / 60,
                stopToIncidentMin:
                  projectToSWithSpeeds(pickStop.s, nS, zones, plan.speeds, base) / 60,
                stopToDestMin:
                  remainingWithSpeeds(pickStop.s, plan.speeds, base, plan.geom.length) / 60,
              });
              if (est) {
                const resumeAt = simNow + driveT + est.waitMin * 60;
                const arrivalS = est.arrivalMin * 60;
                stop = {
                  name: pickStop.name,
                  waitMin: est.waitMin,
                  arrivalClock: formatEta(simNow, arrivalS),
                  arrivalLoClock: formatEta(simNow, est.arrivalLoMin * 60),
                  arrivalHiClock: formatEta(simNow, est.arrivalHiMin * 60),
                  stopS: pickStop.s,
                  resumeAt,
                  arrivalS,
                };
                if (arrivalS < bestS) {
                  bestS = arrivalS;
                  fastest = 'stop';
                }
              }
            }
          }
        } catch {
          // No stop option.
        }
      }
    }

    if (token !== optionsTokenRef.current) return;
    setOptions({
      stayArrival,
      stayLoClock,
      stayHiClock,
      jamDelayMin,
      jamLoMin,
      jamHiMin,
      mainName,
      reroute,
      stop,
      fastest,
      switchNote,
      stayTotalMin: stay.total / 60,
      rerouteTotalMin: bestAlt ? bestAlt.totalSec / 60 : null,
      stopTotalMin: stop ? stop.arrivalS / 60 : null,
    });
  };

  const chooseStay = () => {
    if (warnedIdsRef.current.length === 0) return;
    pendingSwitchRef.current = null;
    stopPlanRef.current = null;
    setActivePlan(currentIdxRef.current);
    lastPickRef.current = { at: simTimeRef.current, planIdx: currentIdxRef.current };
    setChoice({
      kind: 'stay',
      label: `Stay on ${options?.mainName ?? 'route'}`,
      incidentId: warnedIdsRef.current[0],
    });
    void computeOptions();
  };

  const chooseReroute = () => {
    const o = options?.reroute;
    if (
      !o?.available ||
      o.altIdx === undefined ||
      o.divergeS === undefined ||
      o.altS === undefined ||
      warnedIdsRef.current.length === 0
    ) {
      return;
    }
    // Everything below is synchronous: the route geometry was prefetched when
    // the warning appeared, so this click makes no network request.
    const t0 = performance.now();
    pendingSwitchRef.current = { altIdx: o.altIdx, divergeS: o.divergeS, altS: o.altS };
    stopPlanRef.current = null;
    setActivePlan(o.altIdx);
    lastPickRef.current = { at: simTimeRef.current, planIdx: o.altIdx };
    setChoice({
      kind: 'reroute',
      label: `Reroute via ${o.viaName}`,
      incidentId: warnedIdsRef.current[0],
    });
    if (!mutedRef.current) {
      speak(
        `Rerouting. Exit at ${o.decideLabel ?? 'the divergence point'} in ${Math.max(1, Math.round(o.decideMin ?? 0))} minutes.`,
      );
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const ms = performance.now() - t0;
        rerouteMsRef.current = ms;
        (window as unknown as { __rerouteMs?: number }).__rerouteMs = ms;
        console.log(`reroute visual in ${ms.toFixed(0)} ms`);
      }),
    );
  };

  const chooseStop = () => {
    const s = options?.stop;
    if (!s || warnedIdsRef.current.length === 0) return;
    stopPlanRef.current = { s: s.stopS, resumeAt: s.resumeAt, name: s.name };
    pendingSwitchRef.current = null;
    setActivePlan(currentIdxRef.current);
    lastPickRef.current = { at: simTimeRef.current, planIdx: currentIdxRef.current };
    setChoice({
      kind: 'stop',
      label: `Wait at ${s.name} (${Math.round(s.waitMin)} min)`,
      incidentId: warnedIdsRef.current[0],
    });
    void computeOptions();
  };

  const runDemoEvent = async (idx: number) => {
    const ev = DEMO_EVENTS[idx];
    try {
      const probeRes = await fetch(`/api/sim/report?clip=${encodeURIComponent(ev.clip)}`);
      if (!probeRes.ok) throw new Error(await readError(probeRes));
      const probe = (await probeRes.json()) as { estimateUSD: number };
      if (probe.estimateUSD > 0) {
        demoRef.current.active = false;
        setDemoOn(false);
        showToast('Demo needs cached results — run the batch first.');
        return;
      }
      const res = await fetch('/api/sim/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clip: ev.clip }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { verdict: SimVerdict };
      const t = simTimeRef.current;
      if (ev.kind === 'report') {
        const anchor = demoAnchorRef.current;
        if (!anchor) return;
        const id = await createIncident({ ...anchor, routeIdx: 0 }, ev.clip, data.verdict, t, ev.from);
        demoRef.current.incidentId = id;
      } else {
        const id = demoRef.current.incidentId;
        if (id !== null) await applyFollowup(id, ev.clip, data.verdict, t, ev.from);
      }
    } catch (err) {
      demoRef.current.active = false;
      setDemoOn(false);
      showToast(err instanceof Error ? err.message : 'Demo report failed.');
    }
  };

  // ---- clip picker modal ----
  const [clips, setClips] = useState<string[]>([]);
  const [clipError, setClipError] = useState('');
  const [clipBusy, setClipBusy] = useState<string | null>(null);
  const [costConfirm, setCostConfirm] = useState<{ clip: string; usd: number } | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    if (phase === 'drive') setIsDemo(isDemoRef.current);
  }, [phase]);

  useEffect(() => {
    if (!modal) return;
    setClips([]);
    setClipError('');
    setCostConfirm(null);
    (async () => {
      try {
        const res = await fetch('/api/lab/clips');
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as { clips: { name: string }[] };
        setClips(data.clips.map((c) => c.name).filter((n) => !n.startsWith('synth-')));
      } catch (err) {
        setClipError(err instanceof Error ? err.message : 'Could not list clips.');
      }
    })();
  }, [modal]);

  const probeClip = async (clip: string): Promise<number | null> => {
    try {
      const res = await fetch(`/api/sim/report?clip=${encodeURIComponent(clip)}`);
      if (!res.ok) throw new Error(await readError(res));
      return ((await res.json()) as { estimateUSD: number }).estimateUSD;
    } catch (err) {
      setClipError(err instanceof Error ? err.message : 'Cost probe failed.');
      return null;
    }
  };

  const runReport = async (clip: string): Promise<SimVerdict | null> => {
    try {
      const res = await fetch('/api/sim/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clip }),
      });
      if (!res.ok) throw new Error(await readError(res));
      return ((await res.json()) as { verdict: SimVerdict }).verdict;
    } catch (err) {
      setClipError(err instanceof Error ? err.message : 'Report failed.');
      return null;
    }
  };

  const finishClipSelection = async (clip: string) => {
    const m = modal;
    if (!m) return;
    const verdict = await runReport(clip);
    if (!verdict) return;
    const t = simTimeRef.current;
    const traffic = trafficGeomRef.current;
    let direction: 'same' | 'oncoming' = 'same';
    if (traffic) {
      let bestD = Infinity;
      let bestDir: 1 | -1 = 1;
      for (const c of carsRef.current) {
        const d = haversineMeters(pointAt(traffic, c.s), { lat: m.lat, lng: m.lng });
        if (d < bestD) {
          bestD = d;
          bestDir = c.dir;
        }
      }
      direction = bestDir === -1 ? 'oncoming' : 'same';
    }
    if (m.mode === 'drop') {
      await createIncident(
        { s: m.s, lat: m.lat, lng: m.lng, routeIdx: m.routeIdx },
        clip,
        verdict,
        t,
        direction,
      );
      setModal(null);
    } else if (m.incidentId !== null) {
      await applyFollowup(m.incidentId, clip, verdict, t, direction);
      setModal(null);
    }
  };

  const selectClip = async (clip: string) => {
    if (!modal || clipBusy) return;
    setClipBusy(clip);
    setClipError('');
    const est = await probeClip(clip);
    if (est === null) {
      setClipBusy(null);
      return;
    }
    if (est > 0) {
      setCostConfirm({ clip, usd: est });
      setClipBusy(null);
      return;
    }
    await finishClipSelection(clip);
    setClipBusy(null);
  };

  const confirmCost = async () => {
    if (!costConfirm) return;
    const clip = costConfirm.clip;
    setCostConfirm(null);
    setClipBusy(clip);
    await finishClipSelection(clip);
    setClipBusy(null);
  };

  // ---- trip reset / return ----
  const returnHome = () => {
    tripRef.current = null;
    destReqRef.current = null;
    isDemoRef.current = false;
    carsRef.current = [];
    trafficGeomRef.current = null;
    trafficSpeedsRef.current = [];
    yourCarRef.current = { s: 0, arrived: false };
    simTimeRef.current = 0;
    demoRef.current = { active: false, fired: 0, incidentId: null };
    demoChainRef.current = Promise.resolve();
    demoAnchorRef.current = null;
    pendingSwitchRef.current = null;
    stopPlanRef.current = null;
    activeIdxRef.current = 0;
    planChosenAtRef.current = 0;
    candRef.current = null;
    lastPickRef.current = null;
    lastChangeRef.current = 0;
    returnSaveRef.current = null;
    returnThresholdRef.current = null;
    nextIdRef.current = 1;
    setIncidents([]);
    setSelectedId(null);
    setWarnedIds([]);
    setOptions(null);
    setChoice(null);
    setReturnOffer(null);
    setActiveIdxState(0);
    setCurrentIdx(0);
    setArming(false);
    setModal(null);
    setEvidencePlay(null);
    setDemoOn(false);
    setFollow(true);
    setPlaying(true);
    setIsDemo(false);
    setPlan(null);
    setPhase('plan');
  };

  const acceptReturn = () => {
    if (!returnOffer) return;
    pendingSwitchRef.current = { altIdx: 0, divergeS: returnOffer.convAltS, altS: returnOffer.origS };
    stopPlanRef.current = null;
    setActivePlan(0);
    lastPickRef.current = { at: simTimeRef.current, planIdx: 0 };
    setChoice({ kind: 'reroute', label: 'Return to original route', incidentId: -1 });
    setReturnOffer(null);
    showToast('Returning to the original route at the merge.');
  };

  // ---- render ----
  const planRoute = tripRef.current?.routes[activeIdx] ?? null;
  const planLabel = planRoute ? routeName(planRoute.data.description, planRoute.data.steps) : '';
  const warnedList = warnedIds
    .map((id) => incidents.find((i) => i.id === id))
    .filter((i): i is SimIncident => !!i);
  const warned = warnedList[0] ?? null;
  let warnDist = '';
  let warnTime = '';
  let warnHeadline = '';
  let warnRangeLine = '';
  let warnLowReason: string | null = null;
  let warnReason = '';
  let warnNarrows = '';
  let warnSource: 'muse-wonder' | 'fallback table' | null = null;
  let warnUnconfirmed: string | null = null;
  const warnEntries: { id: number; name: string; dist: string; about: string }[] = [];
  if (warned && planRoute) {
    const aS = activeS();
    for (const w of warnedList) {
      const s = incidentSOn(w, planRoute.geom);
      const latestW = w.assessments[w.assessments.length - 1] ?? null;
      const about = latestW
        ? (() => {
            const rem = displayClearance(
              latestW.assessment,
              (hud.simTime - latestW.atT) / 60,
              w.reports.some((r) => !r.incident),
            );
            return rem.unconfirmed ? 'about 5 min (unconfirmed)' : `about ${rem.likelyMin} min`;
          })()
        : 'estimating…';
      warnEntries.push({
        id: w.id,
        name: w.summary,
        dist: fmtMi(Math.max(0, s - aS)),
        about,
      });
    }
    const wS = incidentSOn(warned, planRoute.geom);
    warnDist = fmtMi(Math.max(0, wS - aS));
    warnTime = fmtMin(
      projectToSWithSpeeds(aS, wS, zonesRef.current, planRoute.speeds, YOUR_BASE_MPS),
    );
    const latest = warned.assessments[warned.assessments.length - 1] ?? null;
    if (latest) {
      const remaining = displayClearance(
        latest.assessment,
        (hud.simTime - latest.atT) / 60,
        warned.reports.some((r) => !r.incident),
      );
      warnSource = latest.source;
      if (remaining.unconfirmed && remaining.unconfirmedLabel) {
        warnHeadline = 'Clears in about 5 min';
        warnRangeLine = 'Range 0–10 min';
        warnUnconfirmed = remaining.unconfirmedLabel;
      } else {
        warnHeadline = `Clears in about ${remaining.likelyMin} min`;
        warnRangeLine = `Range ${remaining.lowMin}–${remaining.highMin} min · ${capFirst(latest.assessment.confidence)} confidence`;
      }
      if (latest.assessment.confidence === 'low') {
        warnLowReason =
          latest.assessment.uncertainties[0] ?? latest.assessment.rangeReason;
      }
      warnReason = latest.assessment.rangeReason;
      warnNarrows = stripNarrowsPrefix(latest.assessment.narrowsIf);
    } else {
      const clear = clearanceEstimate(warned.type, warned.stage, warned.severity);
      warnHeadline =
        clear.likelyMin !== null
          ? `Clears in about ${clear.likelyMin} min`
          : 'Work zone, ongoing';
      warnRangeLine =
        clear.loMin !== null && clear.hiMin !== null
          ? `Range ${clear.loMin}–${clear.hiMin} min`
          : '';
    }
  }
  const rOpt = options?.reroute;
  const cardSelected =
    pendingSwitchRef.current && choice?.kind === 'reroute'
      ? 'reroute'
      : choice && warnedIds.includes(choice.incidentId)
        ? choice.kind
        : null;
  const chosenKind = cardSelected;
  let rerouteBanner: string | null = null;
  {
    const pend = pendingSwitchRef.current;
    const g = tripRef.current?.routes[currentIdxRef.current]?.geom ?? null;
    if (chosenKind === 'reroute' && pend && rOpt?.available && rOpt.decideLabel && g) {
      const nMin = Math.max(
        1,
        Math.round(
          projectToSWithSpeeds(
            yourCarRef.current.s,
            pend.divergeS,
            zonesRef.current,
            yourSpeeds(),
            YOUR_BASE_MPS,
          ) / 60,
        ),
      );
      rerouteBanner = `Rerouting: exit at ${rOpt.decideLabel} in ${nMin} min`;
    }
  }

  const tryStillFor = (second: number): string | null => {
    const stills = tryStillsRef.current;
    if (stills.length === 0) return null;
    let best = stills[0];
    for (const s of stills) {
      if (Math.abs(s.seconds - second) < Math.abs(best.seconds - second)) best = s;
    }
    return best.jpeg;
  };

  // Landing-page entry points: ?demo=1 auto-plays the I-95 demo, ?try=1 imports a
  // /try result as a dropped incident near Exit 27 (no new AI calls; $0).
  useEffect(() => {
    if (autoStartRef.current) return;
    autoStartRef.current = true;
    const q = new URLSearchParams(window.location.search);
    if (q.get('demo') === '1') {
      void playDemo();
      return;
    }
    if (q.get('try') !== '1') return;
    const raw = sessionStorage.getItem('try-incident');
    sessionStorage.removeItem('try-incident');
    if (!raw) {
      setPlanError('No /try result found in this tab — analyze a clip first.');
      return;
    }
    let imp: TryImport;
    try {
      imp = JSON.parse(raw) as TryImport;
    } catch {
      setPlanError('Could not read the /try result.');
      return;
    }
    if (!imp || imp.verdict?.incident !== true || !imp.stored?.assessment || !Array.isArray(imp.stills)) {
      setPlanError('That /try result has no incident to place.');
      return;
    }
    (async () => {
      setPlanBusy(true);
      try {
        const routes = await fetchTrip({ address: 'New Haven, CT' }, { address: 'Times Square, New York, NY' });
        const geom = buildRouteGeom(decodePolyline(routes[0].encodedPolyline));
        const snap = nearestOnRoute(geom, EXIT27);
        tryStillsRef.current = imp.stills;
        startDrive(
          {
            originLabel: 'New Haven, CT',
            destLabel: 'Times Square, New York, NY',
            destReq: { address: 'Times Square, New York, NY' },
            routes,
          },
          false,
        );
        await createIncident(
          { s: snap.s, lat: snap.point.lat, lng: snap.point.lng, routeIdx: 0 },
          TRY_CLIP,
          imp.verdict,
          simTimeRef.current,
          'same',
          {
            preAssessed: imp.stored,
            thumbnail: imp.stills[0]?.jpeg ?? null,
            agentCost: imp.cost,
          },
        );
        showToast('Your clip placed near Exit 27.');
      } catch (err) {
        setPlanError(err instanceof Error ? err.message : 'Could not start the drive.');
      } finally {
        setPlanBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'plan') {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 p-4">
        <header>
          <h1 className="text-2xl font-bold">Plan your drive</h1>
          <p className="text-sm text-stone-600">
            Daari Sentinel simulates your trip with live incident warnings.
          </p>
        </header>

        <section className="rounded-lg border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">From</h2>
          {origin.kind === 'locating' && <p className="text-sm">Locating you…</p>}
          {origin.kind === 'geo' && (
            <p className="text-sm">
              My location ({origin.lat.toFixed(4)}, {origin.lng.toFixed(4)})
            </p>
          )}
          {origin.kind === 'default' && (
            <p className="text-sm">New Haven, CT (location unavailable)</p>
          )}
        </section>

        <section className="rounded-lg border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">To</h2>
          <div className="relative">
            <input
              value={toInput}
              onChange={(e) => {
                setToInput(e.target.value);
                setDestPick(null);
              }}
              placeholder="Search a destination"
              aria-label="Destination"
              className="min-h-[44px] w-full rounded-md border border-stone-300 px-3 text-base"
            />
            {suggestions.length > 0 && (
              <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-stone-200 bg-white shadow-lg">
                {suggestions.map((s) => (
                  <li key={s.placeId}>
                    <button
                      type="button"
                      onClick={() => {
                        setDestPick(s);
                        setToInput(s.label);
                        setSuggestions([]);
                      }}
                      className="flex min-h-[44px] w-full items-center px-3 py-2 text-left text-sm hover:bg-stone-100"
                    >
                      {s.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={quickTimesSquare}
            disabled={planBusy}
            className="mt-2 min-h-[44px] w-full rounded-md border border-stone-300 px-3 text-sm disabled:opacity-50"
          >
            Use Times Square, New York
          </button>
          {!BROWSER_KEY && (
            <p className="mt-2 text-sm text-amber-700">
              Destination search needs the browser key (NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY).
            </p>
          )}
        </section>

        {planError && (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {planError}
          </p>
        )}

        <button
          type="button"
          onClick={planTrip}
          disabled={planBusy || (!destPick && toInput.trim().length < 2)}
          className="min-h-[44px] rounded-md bg-stone-900 px-4 font-semibold text-white disabled:opacity-50"
        >
          {planBusy ? 'Finding route…' : 'Get route'}
        </button>

        {plan && (
          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-sm text-stone-600">
              {plan.originLabel} → {plan.destLabel}
            </p>
            <p className="mt-1 text-lg font-semibold">
              {fmtMi(plan.routes[0].distanceMeters)} · {fmtMin(plan.routes[0].durationSeconds)} ·
              ETA {formatEta(0, plan.routes[0].durationSeconds)}
            </p>
            <p className="text-sm text-stone-600">
              {plan.routes.length} route{plan.routes.length === 1 ? '' : 's'} found
            </p>
            <button
              type="button"
              onClick={beginDrive}
              disabled={planBusy}
              className="mt-3 min-h-[44px] w-full rounded-md bg-blue-700 px-4 font-semibold text-white disabled:opacity-50"
            >
              Start drive
            </button>
          </section>
        )}

        <div className="flex items-center gap-3 text-sm text-stone-500">
          <span className="h-px flex-1 bg-stone-200" />
          or
          <span className="h-px flex-1 bg-stone-200" />
        </div>

        <button
          type="button"
          onClick={playDemo}
          disabled={planBusy}
          className="min-h-[44px] rounded-md border border-blue-700 px-4 font-semibold text-blue-700 disabled:opacity-50"
        >
          Play I-95 demo
        </button>
        <p className="text-sm text-stone-600">
          Scripted scenario: New Haven → Times Square with four incident reports near Exit 27,
          Bridgeport.
        </p>
        <footer className="text-xs text-stone-500">
          Demo uses stock road-camera footage as stand-ins for one incident.
        </footer>
      </main>
    );
  }

  const tryStill =
    evidencePlay && evidencePlay.clip === TRY_CLIP ? tryStillFor(evidencePlay.second) : null;

  return (
    <main className="flex min-h-dvh flex-col md:flex-row">
      <div className="relative h-[55dvh] w-full md:h-dvh md:w-[70%]">
        <div ref={mapRef} className="absolute inset-0" />
        {mapStatus === 'loading' && (
          <p className="absolute left-2 top-2 rounded bg-white/90 px-3 py-2 text-sm">
            Loading map…
          </p>
        )}
        {mapStatus === 'error' && (
          <p role="alert" className="absolute left-2 top-2 max-w-[90%] rounded bg-white/95 px-3 py-2 text-sm text-red-700">
            {mapError === 'no-key'
              ? 'Set NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY in .env.local to show the map.'
              : `Map failed: ${mapError}`}
          </p>
        )}
        {(warned || rerouteBanner) && (
          <div className="absolute inset-x-2 top-2 flex flex-col gap-1">
            {warned && (
              <div className="rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white shadow-lg">
                Traffic alert{warnedList.length > 1 ? ` (${warnedList.length})` : ''}: {warned.summary} ({warnDist} ahead)
              </div>
            )}
            {rerouteBanner && (
              <div className="rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white shadow-lg">
                {rerouteBanner}
              </div>
            )}
          </div>
        )}
        {arming && (
          <p className="absolute inset-x-2 bottom-2 rounded-md bg-stone-900/90 px-3 py-2 text-center text-sm font-semibold text-white">
            Tap the map to drop an incident here
          </p>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3 md:h-dvh">
        <section className="rounded-lg border border-stone-200 bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">
              {tripRef.current ? `To ${tripRef.current.destLabel}` : 'Your car'}
            </h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFollow(!follow)}
                aria-pressed={follow}
                className={`min-h-[44px] rounded-md border px-3 text-sm font-semibold ${follow ? 'border-blue-700 bg-blue-50 text-blue-700' : 'border-stone-300'}`}
              >
                {follow ? 'Follow me' : 'Re-center'}
              </button>
              <button
                type="button"
                onClick={() => setMuted(!muted)}
                aria-pressed={muted}
                className="min-h-[44px] rounded-md border border-stone-300 px-3 text-sm font-semibold"
              >
                {muted ? 'Unmute' : 'Mute'}
              </button>
            </div>
          </div>
          <p className="mt-1 text-sm text-stone-600">
            Your route: {planLabel || '—'}
          </p>
          <p className="mt-1 text-sm text-stone-600">
            {hud.arrived
              ? 'Arrived.'
              : `${hud.distLeft.toFixed(1)} mi left · ETA ${hud.eta}`}
            {' · '}sim {formatElapsed(hud.simTime)}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setPlaying(!playing)}
              className="min-h-[44px] rounded-md border border-stone-300 px-4 text-sm font-semibold"
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                aria-pressed={speed === s}
                className={`min-h-[44px] rounded-md border px-4 text-sm font-semibold ${speed === s ? 'border-blue-700 bg-blue-50 text-blue-700' : 'border-stone-300'}`}
              >
                {s}x
              </button>
            ))}
          </div>
          {choice && (
            <p className="mt-2 rounded-md bg-stone-100 px-3 py-2 text-sm">
              You chose: <span className="font-semibold">{choice.label}</span>
            </p>
          )}
        </section>

        {warned && (
          <section className="rounded-lg border-2 border-red-600 bg-white p-3">
            <h2 className="font-bold text-red-700">Traffic alert</h2>
            <ul className="mt-1 flex flex-col gap-1">
              {warnEntries.map((e) => (
                <li key={e.id} className="text-sm">
                  <span className="font-semibold">{e.name}</span>
                  <br />
                  <span className="text-stone-600">
                    {e.dist} ahead · clears in {e.about}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-1 flex flex-wrap gap-1">
              {[pretty(warned.type), pretty(warned.stage)].map((c) => (
                <span key={c} className="rounded bg-stone-100 px-2 py-0.5 text-xs font-semibold">
                  {c}
                </span>
              ))}
            </div>
            {warned.thumbnail && (
              <img
                src={warned.thumbnail}
                alt="Incident evidence"
                className="mt-2 max-h-32 w-full rounded object-cover"
              />
            )}
            <p className="mt-2 text-sm">
              {warnDist} ahead · about {warnTime} away
            </p>
            <p className="text-sm font-semibold">{warnHeadline}</p>
            {warnRangeLine && <p className="text-xs text-stone-600">{warnRangeLine}</p>}
            {warnLowReason && (
              <p className="text-xs font-semibold text-amber-800">Low confidence: {warnLowReason}</p>
            )}
            {warnUnconfirmed && (
              <p className="text-sm text-amber-800">{warnUnconfirmed}</p>
            )}
            {warnReason && <p className="text-xs text-stone-600">{warnReason}</p>}
            {warnNarrows && <p className="text-xs text-stone-600">Narrows if: {warnNarrows}</p>}
            {warnSource && (
              <p className="text-xs text-stone-500">
                {warnSource === 'muse-wonder' ? 'AI assessment · Muse Wonder' : 'Estimate · fallback table'}
              </p>
            )}
            {options && (
              <p className="text-sm">
                Jam delay if you stay: {fmtMin(options.jamDelayMin * 60)} (
                {fmtMin(options.jamLoMin * 60)}–{fmtMin(options.jamHiMin * 60)})
              </p>
            )}
            {rOpt?.available && rOpt.decideLabel ? (
              <p className="text-sm font-semibold">
                Decide by {rOpt.decideLabel} ({fmtMin((rOpt.decideMin ?? 0) * 60)})
              </p>
            ) : (
              rOpt && !rOpt.available && rOpt.reason && (
                <p className="text-sm font-semibold text-amber-800">{rOpt.reason}</p>
              )
            )}
            {!options && <p className="mt-2 text-sm text-stone-600">Finding your options…</p>}
            {options && (
              <div className="mt-2 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={chooseStay}
                  className={`min-h-[44px] rounded-md border p-2 text-left text-sm ${options.fastest === 'stay' ? 'border-green-600 bg-green-50' : 'border-stone-300'} ${chosenKind && chosenKind !== 'stay' ? 'opacity-50' : ''}`}
                >
                  <span className="font-bold">
                    STAY on {options.mainName} (your current route){' '}
                    {chosenKind === 'stay' && <span className="text-blue-700">· Selected ✓</span>}
                    {options.fastest === 'stay' && <span className="text-green-700">· Fastest</span>}
                  </span>
                  <br />
                  Arrive {options.stayArrival} ({options.stayLoClock}–{options.stayHiClock})
                </button>
                {rOpt?.available ? (
                  <button
                    type="button"
                    onClick={chooseReroute}
                    className={`min-h-[44px] rounded-md border p-2 text-left text-sm ${options.fastest === 'reroute' ? 'border-green-600 bg-green-50' : 'border-stone-300'} ${chosenKind && chosenKind !== 'reroute' ? 'opacity-50' : ''}`}
                  >
                    <span className="font-bold">
                      REROUTE via {rOpt.viaName}{' '}
                      {rOpt.fewestDelays && <span className="text-amber-800">· fewest delays</span>}{' '}
                      {chosenKind === 'reroute' && <span className="text-blue-700">· Selected ✓</span>}
                      {options.fastest === 'reroute' && <span className="text-green-700">· Fastest</span>}
                    </span>
                    <br />
                    Arrive {rOpt.arrivalClock}
                    {rOpt.diffMin !== undefined &&
                      (rOpt.diffMin > 0.5
                        ? ` (+${Math.round(rOpt.diffMin)} min detour)`
                        : ' (no detour)')}
                    {rOpt.fewestDelays && rOpt.reason && (
                      <>
                        <br />
                        <span className="text-xs text-stone-600">{rOpt.reason}</span>
                      </>
                    )}
                  </button>
                ) : (
                  <p className="rounded-md bg-stone-100 p-2 text-sm">
                    Reroute: {rOpt?.reason ?? 'unavailable'}
                  </p>
                )}
                {options.switchNote && (
                  <p className="text-xs text-stone-600">{options.switchNote}</p>
                )}
                {options.stop && (
                  <button
                    type="button"
                    onClick={chooseStop}
                    className={`min-h-[44px] rounded-md border p-2 text-left text-sm ${options.fastest === 'stop' ? 'border-green-600 bg-green-50' : 'border-stone-300'} ${chosenKind && chosenKind !== 'stop' ? 'opacity-50' : ''}`}
                  >
                    <span className="font-bold">
                      STOP & WAIT at {options.stop.name}{' '}
                      {chosenKind === 'stop' && <span className="text-blue-700">· Selected ✓</span>}
                      {options.fastest === 'stop' && <span className="text-green-700">· Fastest</span>}
                    </span>
                    <br />
                    Wait {fmtMin(options.stop.waitMin * 60)} · arrive {options.stop.arrivalClock} ({options.stop.arrivalLoClock}–{options.stop.arrivalHiClock})
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {returnOffer && warnedIds.length === 0 && (
          <section className="rounded-lg border border-green-600 bg-green-50 p-3">
            <p className="text-sm font-semibold">
              Return to {tripRef.current ? routeName(tripRef.current.routes[0].data.description, tripRef.current.routes[0].data.steps) : 'original route'} (saves {Math.round(returnOffer.saveMin)} min)
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={acceptReturn}
                className="min-h-[44px] flex-1 rounded-md bg-green-700 px-3 text-sm font-semibold text-white"
              >
                Return to I-95
              </button>
              <button
                type="button"
                onClick={() => setReturnOffer(null)}
                className="min-h-[44px] rounded-md border border-stone-300 bg-white px-3 text-sm font-semibold"
              >
                Stay
              </button>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setArming(!arming)}
            className="min-h-[44px] rounded-md bg-stone-900 px-4 text-sm font-semibold text-white"
          >
            {arming ? 'Cancel drop' : 'Drop incident'}
          </button>
          {isDemo && !demoOn && (
            <button
              type="button"
              onClick={() => {
                demoRef.current = { active: true, fired: 0, incidentId: null };
                demoChainRef.current = Promise.resolve();
                setDemoOn(true);
              }}
              className="min-h-[44px] rounded-md border border-blue-700 px-4 text-sm font-semibold text-blue-700"
            >
              Play I-95 demo reports
            </button>
          )}
          <button
            type="button"
            onClick={returnHome}
            className="min-h-[44px] rounded-md border border-stone-300 px-4 text-sm font-semibold"
          >
            New trip
          </button>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Incidents ({incidents.length})</h2>
          {incidents.length === 0 && (
            <p className="text-sm text-stone-600">No incidents reported yet.</p>
          )}
          {incidents.map((i) => {
            const st = TYPE_PIN[i.type] ?? TYPE_PIN.unknown;
            const latest = i.assessments[i.assessments.length - 1] ?? null;
            const remaining = latest
              ? displayClearance(
                  latest.assessment,
                  (hud.simTime - latest.atT) / 60,
                  i.reports.some((r) => !r.incident),
                )
              : null;
            const reportClip = (reportId: string): string | null =>
              i.reports.find((r) => r.reportId === reportId)?.clip ?? null;
            return (
              <article
                key={i.id}
                className={`rounded-lg border bg-white p-3 ${i.id === selectedId ? 'border-blue-700 ring-1 ring-blue-700' : 'border-stone-200'}`}
              >
                <div className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                    style={{ backgroundColor: i.active ? st.color : '#78716c' }}
                  >
                    {st.letter}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{i.summary}</p>
                    <p className="text-xs text-stone-600">
                      {pretty(i.type)} · {pretty(i.stage)}
                      {i.active ? '' : ' · cleared'} · car #{i.reporterCar}
                    </p>
                  </div>
                </div>
                {latest && remaining && (
                  <div className="mt-2 rounded-md bg-stone-50 p-2">
                    <p className="text-sm font-semibold">
                      {remaining.unconfirmed
                        ? 'Clears in about 5 min'
                        : `Clears in about ${remaining.likelyMin} min`}
                    </p>
                    <p className="text-xs text-stone-600">
                      {remaining.unconfirmed
                        ? 'Range 0–10 min'
                        : `Range ${remaining.lowMin}–${remaining.highMin} min · ${capFirst(latest.assessment.confidence)} confidence`}
                    </p>
                    {latest.assessment.confidence === 'low' && (
                      <p className="text-xs font-semibold text-amber-800">
                        Low confidence:{' '}
                        {latest.assessment.uncertainties[0] ?? latest.assessment.rangeReason}
                      </p>
                    )}
                    {remaining.unconfirmed && remaining.unconfirmedLabel && (
                      <p className="text-xs text-amber-800">{remaining.unconfirmedLabel}</p>
                    )}
                    <p className="text-xs text-stone-600">{latest.assessment.rangeReason}</p>
                    <p className="text-xs text-stone-600">
                      Narrows if: {stripNarrowsPrefix(latest.assessment.narrowsIf)}
                    </p>
                    <p className="text-xs text-stone-500">
                      {latest.source === 'muse-wonder'
                        ? 'AI assessment · Muse Wonder'
                        : 'Estimate · fallback table'}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {latest.assessment.evidence.map((e, idx) => (
                        <button
                          key={idx}
                          type="button"
                          title={e.claim}
                          aria-label={`Play Report ${reportNumber(e.reportId)} at ${fmtClock(e.second)}: ${e.claim}`}
                          onClick={() => {
                            const clip = reportClip(e.reportId);
                            if (!clip) return;
                            setEvidencePlay({
                              clip,
                              second: e.second,
                              label: `Report ${reportNumber(e.reportId)} · ${fmtClock(e.second)} · ${e.claim}`,
                            });
                          }}
                          className="flex min-h-[44px] min-w-0 max-w-full items-center gap-1 rounded-full border border-stone-400 bg-white px-3 py-2 text-left text-xs font-semibold hover:border-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-700"
                        >
                          <span aria-hidden className="shrink-0 text-blue-700">▶</span>
                          <span className="shrink-0">
                            Report {reportNumber(e.reportId)} · {fmtClock(e.second)}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-normal text-stone-600">
                            {e.claim}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {i.id === selectedId && i.thumbnail && (
                  <img
                    src={i.thumbnail}
                    alt="Incident evidence"
                    className="mt-2 max-h-32 w-full rounded object-cover"
                  />
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  {(
                    [
                      ['police', i.responders.police],
                      ['ambulance', i.responders.ambulance],
                      ['fire', i.responders.fire],
                      ['tow', i.responders.towTruck],
                    ] as const
                  ).map(([name, on]) => (
                    <span
                      key={name}
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${on ? 'bg-blue-100 text-blue-800' : 'bg-stone-100 text-stone-500'}`}
                    >
                      {name}
                    </span>
                  ))}
                </div>
                {i.reports.length > 0 && (
                  <ol className="mt-2 flex flex-col gap-1 border-t border-stone-100 pt-2">
                    {i.reports.map((r, idx) => {
                      const a = i.assessments[idx] ?? null;
                      return (
                        <li key={idx} className="text-xs text-stone-600">
                          {formatElapsed(r.t)} · {r.clip} · {pretty(r.stage)}
                          {r.direction === 'oncoming' ? ' · seen by an oncoming car' : ''}
                          {a &&
                            ` · ${a.assessment.changesSinceLast} · ${Math.round(a.assessment.clearance.lowMin)}–${Math.round(a.assessment.clearance.highMin)} min`}
                        </li>
                      );
                    })}
                  </ol>
                )}
                <p className="mt-1 text-xs tabular-nums text-stone-500">
                  AI assessment: {fmtUSD(i.agentCost)}
                </p>
                {i.active && (
                  <button
                    type="button"
                    onClick={() =>
                      setModal({
                        mode: 'followup',
                        s: i.s,
                        lat: i.lat,
                        lng: i.lng,
                        routeIdx: i.routeIdx,
                        incidentId: i.id,
                      })
                    }
                    className="mt-2 min-h-[44px] w-full rounded-md border border-stone-300 px-3 text-sm font-semibold"
                  >
                    Add follow-up report
                  </button>
                )}
              </article>
            );
          })}
        </section>
        <footer className="text-xs text-stone-500">
          Demo uses stock road-camera footage as stand-ins for one incident.
        </footer>
      </div>

      {modal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center"
        >
          <div className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-4">
            <h2 className="font-bold">
              {modal.mode === 'drop' ? 'Drop incident: pick a clip' : 'Follow-up: pick a clip'}
            </h2>
            {clipError && (
              <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">
                {clipError}
              </p>
            )}
            {costConfirm && (
              <div className="mt-2 rounded bg-amber-50 p-3 text-sm">
                <p>
                  This report costs {fmtUSD(costConfirm.usd)} (uncached AI). Continue?
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={confirmCost}
                    className="min-h-[44px] flex-1 rounded-md bg-amber-600 px-3 font-semibold text-white"
                  >
                    Pay & run
                  </button>
                  <button
                    type="button"
                    onClick={() => setCostConfirm(null)}
                    className="min-h-[44px] flex-1 rounded-md border border-stone-300 px-3 font-semibold"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <ul className="mt-2 flex flex-col gap-1">
              {clips.map((clip) => (
                <li key={clip}>
                  <button
                    type="button"
                    onClick={() => selectClip(clip)}
                    disabled={clipBusy !== null}
                    className="min-h-[44px] w-full rounded-md border border-stone-200 px-3 py-2 text-left text-sm hover:bg-stone-50 disabled:opacity-50"
                  >
                    {clipBusy === clip ? 'Running AI…' : clip}
                  </button>
                </li>
              ))}
              {clips.length === 0 && !clipError && (
                <li className="text-sm text-stone-600">Loading clips…</li>
              )}
            </ul>
            <button
              type="button"
              onClick={() => setModal(null)}
              className="mt-3 min-h-[44px] w-full rounded-md border border-stone-300 px-3 text-sm font-semibold"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {evidencePlay && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Evidence clip"
          onClick={() => setEvidencePlay(null)}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{evidencePlay.label}</p>
                <p className="text-xs text-stone-600">
                  {evidencePlay.clip === TRY_CLIP ? 'Your clip' : evidencePlay.clip} ·{' '}
                  {evidencePlay.clip === TRY_CLIP ? 'still near' : 'from'} {fmtClock(evidencePlay.second)}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close evidence clip"
                onClick={() => setEvidencePlay(null)}
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border border-stone-300 text-lg font-semibold hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-700"
              >
                ✕
              </button>
            </div>
            {evidencePlay.clip === TRY_CLIP ? (
              tryStill ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={tryStill}
                  alt={`Still from your clip near ${fmtClock(evidencePlay.second)}`}
                  className="mt-2 block h-auto w-full rounded bg-black"
                />
              ) : (
                <p className="mt-2 text-sm text-stone-600">
                  Still not available (the clip was deleted after analysis).
                </p>
              )
            ) : (
              <video
                key={`${evidencePlay.clip}-${evidencePlay.second}`}
                src={`${clipVideoUrl(evidencePlay.clip)}#t=${evidencePlay.second}`}
                controls
                autoPlay
                playsInline
                className="mt-2 block h-auto w-full rounded bg-black"
              />
            )}
            <button
              type="button"
              onClick={() => setEvidencePlay(null)}
              className="mt-3 min-h-[44px] w-full rounded-md border border-stone-300 px-3 text-sm font-semibold"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {toast && (
        <p className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-md bg-stone-900 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg">
          {toast.message}
        </p>
      )}
    </main>
  );
}
