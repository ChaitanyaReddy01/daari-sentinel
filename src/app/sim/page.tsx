/* eslint-disable @typescript-eslint/no-explicit-any */
// Reason: the Google Maps JS API has no bundled types here (`any` stays at
// the Maps boundary and never leaks into sim math), and thumbnails are plain
// <img> tags served from our own cached API route.
'use client';

import { useEffect, useRef, useState } from 'react';

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
  projectEta,
  speedInZones,
  stageSpeedMps,
  stepCar,
  type RouteGeom,
  type SimCar,
  type SlowZone,
} from '@/lib/sim';
import {
  WAIT_RESIDUAL_MIN,
  beep,
  decideByLabel,
  findDivergence,
  minDistanceToRoute,
  offRouteCandidates,
  projectToS,
  rerouteDelayMin,
  routeName,
  routesRemainSec,
  speak,
  stayDelayRange,
  subPath,
} from './drive';

const BROWSER_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? '';
const SIM_SEED = 1337;
const YOUR_BASE_MPS = 60 * MPH_TO_MPS;
const SLOW_AHEAD_METERS = 0.5 * METERS_PER_MILE;
const WARN_LATERAL_METERS = 300;
const SPEEDS = [1, 10, 30] as const;
const ROUTE_BLUE = '#1a73e8';
const NEW_HAVEN = { lat: 41.3083, lng: -72.9279 };

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
}

interface SimIncident {
  id: number;
  routeIdx: number;
  s: number;
  lat: number;
  lng: number;
  reporterCar: number;
  reports: SimReport[];
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
}

interface StopOption {
  name: string;
  waitMin: number;
  arrivalClock: string;
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
  const [warningId, setWarningId] = useState<number | null>(null);
  const [options, setOptions] = useState<WarningOptions | null>(null);
  const [returnOffer, setReturnOffer] = useState<{
    convAltS: number;
    origS: number;
    saveMin: number;
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
  const markersRef = useRef<any[]>([]);
  const tripRef = useRef<{ routes: DriveRoute[]; originLabel: string; destLabel: string } | null>(null);
  const destReqRef = useRef<TripPlan['destReq'] | null>(null);
  const isDemoRef = useRef(false);
  const carsRef = useRef<SimCar[]>([]);
  const trafficGeomRef = useRef<RouteGeom | null>(null);
  const yourCarRef = useRef({ s: 0, arrived: false });
  const simTimeRef = useRef(0);
  const playingRef = useRef(true);
  const speedRef = useRef<(typeof SPEEDS)[number]>(10);
  const armingRef = useRef(false);
  const followRef = useRef(true);
  const mutedRef = useRef(false);
  const incidentsRef = useRef<SimIncident[]>([]);
  const zonesRef = useRef<SlowZone[]>([]);
  const currentIdxRef = useRef(0);
  const pendingSwitchRef = useRef<{ altIdx: number; divergeS: number; altS: number } | null>(null);
  const stopPlanRef = useRef<{ s: number; resumeAt: number; name: string } | null>(null);
  const warningIdRef = useRef<number | null>(null);
  const optionsTokenRef = useRef(0);
  const demoRef = useRef({ active: false, fired: 0, incidentId: null as number | null });
  const demoAnchorRef = useRef<{ s: number; lat: number; lng: number } | null>(null);
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
    warningIdRef.current = warningId;
  }, [warningId]);

  const yourGeom = (): RouteGeom | null => {
    const trip = tripRef.current;
    if (!trip) return null;
    return trip.routes[currentIdxRef.current]?.geom ?? null;
  };

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
    const routes: DriveRoute[] = trip.routes.map((data) => ({
      data,
      geom: buildRouteGeom(decodePolyline(data.encodedPolyline)),
    }));
    tripRef.current = { routes, originLabel: trip.originLabel, destLabel: trip.destLabel };
    destReqRef.current = trip.destReq;
    isDemoRef.current = demo;
    trafficGeomRef.current = routes[0].geom;
    carsRef.current = createCars(SIM_SEED, routes[0].geom.length);
    yourCarRef.current = { s: 0, arrived: false };
    simTimeRef.current = 0;
    pendingSwitchRef.current = null;
    stopPlanRef.current = null;
    setCurrentIdx(0);
    setIncidents([]);
    setSelectedId(null);
    setChoice(null);
    setWarningId(null);
    setOptions(null);
    setReturnOffer(null);
    setPlaying(true);
    setFollow(true);
    demoRef.current = { active: false, fired: 0, incidentId: null };
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
      if (overlay) overlay.setMap(null);
      if (routeLineRef.current) routeLineRef.current.setMap(null);
      for (const m of markersRef.current) m.setMap(null);
      markersRef.current = [];
      routeLineRef.current = null;
      mapRef2.current = null;
      overlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Current route line (blue) follows reroutes; refit only on a new trip.
  useEffect(() => {
    const map = mapRef2.current;
    const trip = tripRef.current;
    if (!map || !trip || mapStatus !== 'ready') return;
    const g = trip.routes[currentIdx]?.geom;
    if (!g) return;
    if (routeLineRef.current) routeLineRef.current.setMap(null);
    routeLineRef.current = new (googleRef.current as any).maps.Polyline({
      path: g.points,
      strokeColor: ROUTE_BLUE,
      strokeWeight: 5,
      strokeOpacity: 0.95,
      zIndex: 1,
      map,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, currentIdx]);

  useEffect(() => {
    const map = mapRef2.current;
    const trip = tripRef.current;
    if (!map || !trip || mapStatus !== 'ready') return;
    const g = trip.routes[0].geom;
    const bounds = new (googleRef.current as any).maps.LatLngBounds();
    for (const p of g.points) bounds.extend(p);
    map.fitBounds(bounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

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

  const zonesForRoute = (routeIdx: number): SlowZone[] =>
    incidentsRef.current
      .filter((i) => i.active && i.routeIdx === routeIdx)
      .flatMap((i) => {
        const mph = stageSpeedMps(i.stage);
        if (mph === null) return [];
        return [{ s0: i.s - SLOW_AHEAD_METERS, s1: i.s, mps: mph * MPH_TO_MPS }];
      });

  // ETA basis shared with the option cards: Routes duration prorated by
  // distance, plus the live sim slowdown over the same stretch.
  const legSec = (fromS: number, toS: number, zones: SlowZone[]): number => {
    const g = yourGeom();
    const dur = tripRef.current?.routes[currentIdxRef.current]?.data.durationSeconds ?? 0;
    if (g && dur > 0) {
      const routesLeg = routesRemainSec(dur, g.length, fromS) - routesRemainSec(dur, g.length, toS);
      const extra = Math.max(
        0,
        projectToS(fromS, toS, zones, YOUR_BASE_MPS) - projectToS(fromS, toS, [], YOUR_BASE_MPS),
      );
      return Math.max(0, routesLeg) + extra;
    }
    return projectToS(fromS, toS, zones, YOUR_BASE_MPS);
  };

  const freeLegSec = (fromS: number): number => {
    const g = yourGeom();
    const dur = tripRef.current?.routes[currentIdxRef.current]?.data.durationSeconds ?? 0;
    if (g && dur > 0) return routesRemainSec(dur, g.length, fromS);
    return g ? (g.length - fromS) / YOUR_BASE_MPS : 0;
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
          void runDemoEvent(idx);
        }
        const trafficZones = zonesForRoute(0);
        for (const car of carsRef.current) stepCar(car, dt, trafficZones, traffic.length);
        const yourZones = zonesForRoute(currentIdxRef.current);
        zonesRef.current = yourZones;
        const you = yourCarRef.current;
        if (!you.arrived) {
          const stop = stopPlanRef.current;
          if (stop && you.s >= stop.s) {
            if (simTimeRef.current >= stop.resumeAt) stopPlanRef.current = null;
          } else {
            you.s += speedInZones(YOUR_BASE_MPS, you.s, yourZones) * dt;
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
      if (map && followRef.current && !yourCarRef.current.arrived) {
        const yp = pointAt(yours, yourCarRef.current.s);
        map.setCenter({ lat: yp.lat, lng: yp.lng });
      }
      uiAcc += dtReal;
      if (uiAcc >= 0.25) {
        uiAcc = 0;
        zonesRef.current = zonesForRoute(currentIdxRef.current);
        const you = yourCarRef.current;
        const g = yourGeom();
        if (g) {
          const proj = projectEta(you.s, zonesRef.current, YOUR_BASE_MPS, g.length);
          let etaS = legSec(you.s, g.length, zonesRef.current);
          const stop = stopPlanRef.current;
          if (stop && !you.arrived) {
            if (you.s >= stop.s) {
              etaS = Math.max(0, stop.resumeAt - simTimeRef.current) + freeLegSec(you.s);
            } else {
              const driveT = legSec(you.s, stop.s, zonesRef.current);
              etaS =
                driveT +
                Math.max(0, stop.resumeAt - (simTimeRef.current + driveT)) +
                freeLegSec(stop.s);
            }
          }
          setHud({
            simTime: simTimeRef.current,
            distLeft: proj.milesLeft,
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

  // Pins: the warned incident gets its type color; everything else is small gray.
  useEffect(() => {
    const google = googleRef.current;
    const map = mapRef2.current;
    if (!google || !map || mapStatus !== 'ready') return;
    for (const m of markersRef.current) m.setMap(null);
    markersRef.current = incidents.map((i) => {
      const warned = i.id === warningId;
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
  }, [incidents, selectedId, warningId, mapStatus]);

  const closestCarId = (lat: number, lng: number): number => {
    const traffic = trafficGeomRef.current;
    let best = 0;
    let bestD = Infinity;
    for (const c of carsRef.current) {
      if (!traffic) break;
      const d = haversineMeters(pointAt(traffic, c.s), { lat, lng });
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  };

  const createIncident = (
    point: { s: number; lat: number; lng: number; routeIdx: number },
    clip: string,
    verdict: SimVerdict,
    t: number,
  ): number | null => {
    if (!verdict.incident) {
      showToast('Report checked: no incident');
      return null;
    }
    const id = nextIdRef.current++;
    const first = verdict.evidence[0];
    const inc: SimIncident = {
      id,
      routeIdx: point.routeIdx,
      s: point.s,
      lat: point.lat,
      lng: point.lng,
      reporterCar: closestCarId(point.lat, point.lng),
      reports: [
        { t, clip, stage: verdict.stage, summary: verdict.summary, incident: verdict.incident },
      ],
      stage: verdict.stage,
      severity: verdict.severity,
      lanesBlocked: verdict.lanesBlocked ?? 'unknown',
      active: true,
      thumbnail:
        first !== undefined
          ? `/api/sim/thumbnail?clip=${encodeURIComponent(clip)}&second=${first.second}`
          : null,
      responders: verdict.responders,
      summary: verdict.summary,
      type: verdict.type,
    };
    setIncidents((prev) => [...prev, inc]);
    setSelectedId(id);
    return id;
  };

  const applyFollowup = (incidentId: number, clip: string, verdict: SimVerdict, t: number) => {
    const prev = incidentsRef.current.find((i) => i.id === incidentId);
    if (!prev) return;
    const cleared = !verdict.incident || verdict.stage === 'cleared';
    const stage = cleared ? 'cleared' : verdict.stage;
    const next: SimIncident = {
      ...prev,
      reports: [
        ...prev.reports,
        { t, clip, stage, summary: verdict.summary, incident: verdict.incident },
      ],
      stage,
      severity: verdict.severity,
      lanesBlocked: verdict.lanesBlocked ?? 'unknown',
      active: !cleared,
      summary: verdict.summary,
      type: verdict.type,
      responders: verdict.responders,
    };
    setIncidents((list) => list.map((i) => (i.id === incidentId ? next : i)));
    setSelectedId(incidentId);
    if (cleared) {
      handleCleared(next);
      return;
    }
    if (warningIdRef.current === incidentId) {
      const clear = clearanceEstimate(next.type, next.stage, next.severity);
      if (next.stage !== prev.stage) {
        const range =
          clear.loMin !== null && clear.hiMin !== null
            ? `clears in ${clear.loMin}–${clear.hiMin} min`
            : 'work zone, ongoing';
        alert(
          `Updated: ${pretty(next.stage)}, ${range}`,
          `Updated. ${pretty(next.stage)}, ${range}.`,
        );
      }
      void computeOptions(next);
    }
  };

  const handleCleared = (incident: SimIncident) => {
    if (warningIdRef.current === incident.id) {
      setWarningId(null);
      setOptions(null);
    }
    setChoice(null);
    alert('Road clear', 'Road clear.');
    const trip = tripRef.current;
    const curIdx = currentIdxRef.current;
    if (!trip || curIdx === 0) return;
    // Offer the way back only if the original route is faster from here.
    const cur = trip.routes[curIdx];
    const orig = trip.routes[0];
    const youS = yourCarRef.current.s;
    let conv: { altS: number; origS: number } | null = null;
    for (let i = 0; i < cur.geom.points.length; i++) {
      const s = cur.geom.cum[i];
      if (s <= youS) continue;
      if (minDistanceToRoute(orig.geom, cur.geom.points[i]) > 50) continue;
      conv = { altS: s, origS: nearestOnRoute(orig.geom, cur.geom.points[i]).s };
      break;
    }
    if (!conv) return;
    const altRemain = (cur.geom.length - youS) / YOUR_BASE_MPS;
    const origRemain =
      (conv.altS - youS) / YOUR_BASE_MPS +
      projectEta(conv.origS, zonesForRoute(0), YOUR_BASE_MPS, orig.geom.length).seconds;
    if (origRemain + 60 < altRemain) {
      setReturnOffer({ convAltS: conv.altS, origS: conv.origS, saveMin: (altRemain - origRemain) / 60 });
    }
  };

  const evalWarning = () => {
    const g = yourGeom();
    if (!g) return;
    const youS = yourCarRef.current.s;
    let best: SimIncident | null = null;
    for (const i of incidentsRef.current) {
      if (!i.active || i.stage === 'cleared' || i.routeIdx !== currentIdxRef.current) continue;
      if (minDistanceToRoute(g, { lat: i.lat, lng: i.lng }) > WARN_LATERAL_METERS) continue;
      if (i.s <= youS) continue;
      if (!best || i.s < best.s) best = i;
    }
    const id = best ? best.id : null;
    if (id === warningIdRef.current) return;
    if (best) {
      setWarningId(id);
      setChoice(null);
      setReturnOffer(null);
      alert(`Traffic alert: ${best.summary}`, `Traffic alert. ${best.summary}`);
      void computeOptions(best);
    } else {
      setWarningId(null);
      setOptions(null);
      if (!pendingSwitchRef.current) setChoice(null);
    }
  };

  const computeOptions = async (incident: SimIncident) => {
    const token = ++optionsTokenRef.current;
    const trip = tripRef.current;
    const geom = yourGeom();
    if (!trip || !geom) return;
    const youS = yourCarRef.current.s;
    const simNow = simTimeRef.current;
    const base = YOUR_BASE_MPS;
    const L = geom.length;
    const curIdx = currentIdxRef.current;
    const curData = trip.routes[curIdx].data;
    const mainName = routeName(curData.description, curData.steps);
    const mainDur = curData.durationSeconds;
    const mainRemainSec =
      mainDur > 0 ? routesRemainSec(mainDur, L, youS) : projectEta(youS, [], base, L).seconds;
    const zones = zonesForRoute(curIdx);
    const clear = clearanceEstimate(incident.type, incident.stage, incident.severity);
    const lanes = incident.lanesBlocked ?? 'unknown';
    const ageMin = Math.max(0, (simNow - incident.reports[0].t) / 60);
    const tMin =
      (mainDur > 0
        ? (mainDur * Math.max(0, incident.s - youS)) / L
        : projectToS(youS, incident.s, zones, base)) / 60;

    // STAY: clearance-based wait, shown as a range with the midpoint headline.
    let stayMidSec: number;
    let stayArrival: string;
    let stayLoClock: string;
    let stayHiClock: string;
    let jamDelayMin: number;
    let jamLoMin: number;
    let jamHiMin: number;
    if (
      incident.type === 'construction' ||
      clear.loMin === null ||
      clear.midpointMin === null ||
      clear.hiMin === null
    ) {
      const freeS = projectEta(youS, [], base, L).seconds;
      stayMidSec = projectEta(youS, zones, base, L).seconds;
      jamDelayMin = Math.max(0, (stayMidSec - freeS) / 60);
      jamLoMin = jamDelayMin;
      jamHiMin = jamDelayMin;
      stayArrival = formatEta(simNow, stayMidSec);
      stayLoClock = stayArrival;
      stayHiClock = stayArrival;
    } else {
      const range = stayDelayRange(tMin, clear.loMin, clear.midpointMin, clear.hiMin, lanes, ageMin);
      jamDelayMin = range.mid;
      jamLoMin = range.lo;
      jamHiMin = range.hi;
      stayMidSec = mainRemainSec + range.mid * 60;
      stayArrival = formatEta(simNow, stayMidSec);
      stayLoClock = formatEta(simNow, mainRemainSec + range.lo * 60);
      stayHiClock = formatEta(simNow, mainRemainSec + range.hi * 60);
    }
    let fastest: 'stay' | 'reroute' | 'stop' = 'stay';
    let bestS = stayMidSec;
    const incidentPt = { lat: incident.lat, lng: incident.lng };

    // REROUTE: fastest alternative that avoids the incident, else a fresh
    // waypoint route from the current position. Costed on Routes durations.
    const rerouteCost = (
      altData: TripRouteData,
      altLen: number,
      divergeS: number,
      altS: number,
    ): { toDivergeSec: number; altRemainSec: number; totalSec: number } => {
      if (mainDur > 0 && altData.durationSeconds > 0) {
        const toDivergeSec = (mainDur * Math.max(0, divergeS - youS)) / L;
        const altRemainSec = routesRemainSec(altData.durationSeconds, altLen, altS);
        return { toDivergeSec, altRemainSec, totalSec: toDivergeSec + altRemainSec };
      }
      const toDivergeSec = projectToS(youS, divergeS, zones, base);
      const altRemainSec = (altLen - altS) / base;
      return { toDivergeSec, altRemainSec, totalSec: toDivergeSec + altRemainSec };
    };
    let reroute: RerouteOption = { available: false, reason: 'No avoiding route found.' };
    let bestAlt: { altIdx: number; divergeS: number; altS: number; totalSec: number } | null = null;
    for (let idx = 0; idx < trip.routes.length; idx++) {
      if (idx === curIdx) continue;
      const alt = trip.routes[idx];
      if (minDistanceToRoute(alt.geom, incidentPt) <= WARN_LATERAL_METERS) continue;
      const div = findDivergence(geom, alt.geom.points, incident.s, 50);
      if (!div || div.s <= youS) continue;
      const cost = rerouteCost(alt.data, alt.geom.length, div.s, div.altS);
      if (!bestAlt || cost.totalSec < bestAlt.totalSec) {
        bestAlt = { altIdx: idx, divergeS: div.s, altS: div.altS, totalSec: cost.totalSec };
      }
    }
    if (!bestAlt) {
      const destReq = destReqRef.current;
      if (destReq) {
        const pos = pointAt(geom, youS);
        for (const via of offRouteCandidates(geom, incident.s, 2000)) {
          try {
            const routes = await fetchTrip({ lat: pos.lat, lng: pos.lng }, destReq, via);
            const data = routes[0];
            const g = buildRouteGeom(decodePolyline(data.encodedPolyline));
            if (minDistanceToRoute(g, incidentPt) <= WARN_LATERAL_METERS) continue;
            trip.routes.push({ data, geom: g });
            const div = findDivergence(geom, g.points, incident.s, 50);
            if (!div || div.s <= youS) continue;
            const cost = rerouteCost(data, g.length, div.s, div.altS);
            bestAlt = {
              altIdx: trip.routes.length - 1,
              divergeS: div.s,
              altS: div.altS,
              totalSec: cost.totalSec,
            };
            break;
          } catch {
            // Try the other side.
          }
        }
      }
    }
    if (bestAlt) {
      const altData = trip.routes[bestAlt.altIdx].data;
      const altGeom = trip.routes[bestAlt.altIdx].geom;
      const cost = rerouteCost(altData, altGeom.length, bestAlt.divergeS, bestAlt.altS);
      const decideLabel =
        decideByLabel(altData.steps, bestAlt.altS) ??
        `in ${fmtMi(Math.max(0, bestAlt.divergeS - youS))}`;
      reroute = {
        available: true,
        arrivalClock: formatEta(simNow, cost.totalSec),
        diffMin: rerouteDelayMin(cost.toDivergeSec, cost.altRemainSec, mainRemainSec),
        altIdx: bestAlt.altIdx,
        divergeS: bestAlt.divergeS,
        altS: bestAlt.altS,
        viaName: routeName(altData.description, altData.steps),
        decideLabel,
        decideMin: cost.toDivergeSec / 60,
      };
      if (cost.totalSec < bestS) {
        bestS = cost.totalSec;
        fastest = 'reroute';
      }
    }

    // STOP: nearest gas/rest/coffee between you and the decision point.
    // Hidden once the incident clears before you arrive: nothing to wait out.
    let stop: StopOption | null = null;
    if (
      incident.type !== 'construction' &&
      clear.midpointMin !== null &&
      clear.hiMin !== null &&
      tMin < clear.hiMin
    ) {
      const farBound =
        reroute.available && reroute.divergeS !== undefined ? reroute.divergeS : incident.s;
      if (farBound > youS + 50) {
        const mid = pointAt(geom, (youS + farBound) / 2);
        try {
          const res = await fetch(`/api/sim/stops?lat=${mid.lat}&lng=${mid.lng}`);
          if (res.ok) {
            const data = (await res.json()) as {
              stops: { name: string; lat: number; lng: number }[];
            };
            let pick: { name: string; s: number; d: number } | null = null;
            for (const st of data.stops) {
              const snap = nearestOnRoute(geom, st);
              const d = haversineMeters(snap.point, st);
              if (d > 1000 || snap.s <= youS || snap.s >= farBound) continue;
              if (!pick || d < pick.d) pick = { name: st.name, s: snap.s, d };
            }
            if (pick) {
              const driveT = projectToS(youS, pick.s, zones, base);
              const waitMin = Math.max(5, clear.midpointMin - tMin);
              const resumeAt = simNow + driveT + waitMin * 60;
              const arrivalS = mainRemainSec + waitMin * 60 + WAIT_RESIDUAL_MIN * 60;
              stop = {
                name: pick.name,
                waitMin,
                arrivalClock: formatEta(simNow, arrivalS),
                stopS: pick.s,
                resumeAt,
                arrivalS,
              };
              if (arrivalS < bestS) {
                bestS = arrivalS;
                fastest = 'stop';
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
    });
  };

  const chooseStay = () => {
    if (warningIdRef.current === null) return;
    pendingSwitchRef.current = null;
    stopPlanRef.current = null;
    setChoice({
      kind: 'stay',
      label: `Stay on ${options?.mainName ?? 'route'}`,
      incidentId: warningIdRef.current,
    });
  };

  const chooseReroute = () => {
    const o = options?.reroute;
    if (
      !o?.available ||
      o.altIdx === undefined ||
      o.divergeS === undefined ||
      o.altS === undefined ||
      warningIdRef.current === null
    ) {
      return;
    }
    pendingSwitchRef.current = { altIdx: o.altIdx, divergeS: o.divergeS, altS: o.altS };
    stopPlanRef.current = null;
    setChoice({
      kind: 'reroute',
      label: `Reroute via ${o.viaName}`,
      incidentId: warningIdRef.current,
    });
    showToast(`Rerouting at ${o.decideLabel ?? 'the divergence point'}.`);
  };

  const chooseStop = () => {
    const s = options?.stop;
    if (!s || warningIdRef.current === null) return;
    stopPlanRef.current = { s: s.stopS, resumeAt: s.resumeAt, name: s.name };
    pendingSwitchRef.current = null;
    setChoice({
      kind: 'stop',
      label: `Wait at ${s.name} (${Math.round(s.waitMin)} min)`,
      incidentId: warningIdRef.current,
    });
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
        const id = createIncident({ ...anchor, routeIdx: 0 }, ev.clip, data.verdict, t);
        demoRef.current.incidentId = id;
      } else {
        const id = demoRef.current.incidentId;
        if (id !== null) applyFollowup(id, ev.clip, data.verdict, t);
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
        const res = await fetch('/api/sim/clips');
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as { clips: string[] };
        setClips(data.clips);
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
    if (m.mode === 'drop') {
      createIncident({ s: m.s, lat: m.lat, lng: m.lng, routeIdx: m.routeIdx }, clip, verdict, t);
      setModal(null);
    } else if (m.incidentId !== null) {
      applyFollowup(m.incidentId, clip, verdict, t);
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
    yourCarRef.current = { s: 0, arrived: false };
    simTimeRef.current = 0;
    demoRef.current = { active: false, fired: 0, incidentId: null };
    demoAnchorRef.current = null;
    pendingSwitchRef.current = null;
    stopPlanRef.current = null;
    nextIdRef.current = 1;
    setIncidents([]);
    setSelectedId(null);
    setWarningId(null);
    setOptions(null);
    setChoice(null);
    setReturnOffer(null);
    setCurrentIdx(0);
    setArming(false);
    setModal(null);
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
    setChoice({ kind: 'reroute', label: 'Return to original route', incidentId: -1 });
    setReturnOffer(null);
    showToast('Returning to the original route at the merge.');
  };

  // ---- render ----
  const warned = incidents.find((i) => i.id === warningId) ?? null;
  let warnDist = '';
  let warnTime = '';
  let warnClear = '';
  if (warned) {
    const g = yourGeom();
    if (g) {
      const youS = yourCarRef.current.s;
      warnDist = fmtMi(Math.max(0, warned.s - youS));
      warnTime = fmtMin(projectToS(youS, warned.s, zonesRef.current, YOUR_BASE_MPS));
      const clear = clearanceEstimate(warned.type, warned.stage, warned.severity);
      warnClear =
        clear.loMin !== null && clear.hiMin !== null
          ? `${clear.loMin}–${clear.hiMin} min (estimate)`
          : 'work zone, ongoing';
    }
  }
  const rOpt = options?.reroute;

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
      </main>
    );
  }

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
        {warned && (
          <div className="absolute inset-x-2 top-2 rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white shadow-lg">
            Traffic alert: {warned.summary} ({warnDist} ahead)
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
                Follow me
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
            <p className="mt-1 text-sm font-semibold">{warned.summary}</p>
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
            <p className="text-sm">Clears in: {warnClear}</p>
            {options && (
              <p className="text-sm">
                Jam delay if you stay: {fmtMin(options.jamDelayMin * 60)} (
                {fmtMin(options.jamLoMin * 60)}–{fmtMin(options.jamHiMin * 60)})
              </p>
            )}
            {rOpt?.available && rOpt.decideLabel && (
              <p className="text-sm font-semibold">
                Decide by {rOpt.decideLabel} ({fmtMin((rOpt.decideMin ?? 0) * 60)})
              </p>
            )}
            {!options && <p className="mt-2 text-sm text-stone-600">Finding your options…</p>}
            {options && (
              <div className="mt-2 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={chooseStay}
                  className={`min-h-[44px] rounded-md border p-2 text-left text-sm ${options.fastest === 'stay' ? 'border-green-600 bg-green-50' : 'border-stone-300'}`}
                >
                  <span className="font-bold">
                    STAY on {options.mainName}{' '}
                    {options.fastest === 'stay' && <span className="text-green-700">· Fastest</span>}
                  </span>
                  <br />
                  Arrive {options.stayArrival} ({options.stayLoClock}–{options.stayHiClock})
                </button>
                {rOpt?.available ? (
                  <button
                    type="button"
                    onClick={chooseReroute}
                    className={`min-h-[44px] rounded-md border p-2 text-left text-sm ${options.fastest === 'reroute' ? 'border-green-600 bg-green-50' : 'border-stone-300'}`}
                  >
                    <span className="font-bold">
                      REROUTE via {rOpt.viaName}{' '}
                      {options.fastest === 'reroute' && <span className="text-green-700">· Fastest</span>}
                    </span>
                    <br />
                    Arrive {rOpt.arrivalClock}
                    {rOpt.diffMin !== undefined &&
                      (rOpt.diffMin > 0.5
                        ? ` (+${Math.round(rOpt.diffMin)} min detour)`
                        : ' (no detour)')}
                  </button>
                ) : (
                  <p className="rounded-md bg-stone-100 p-2 text-sm">
                    Reroute: {rOpt?.reason ?? 'unavailable'}
                  </p>
                )}
                {options.stop && (
                  <button
                    type="button"
                    onClick={chooseStop}
                    className={`min-h-[44px] rounded-md border p-2 text-left text-sm ${options.fastest === 'stop' ? 'border-green-600 bg-green-50' : 'border-stone-300'}`}
                  >
                    <span className="font-bold">
                      STOP & WAIT at {options.stop.name}{' '}
                      {options.fastest === 'stop' && <span className="text-green-700">· Fastest</span>}
                    </span>
                    <br />
                    Wait {fmtMin(options.stop.waitMin * 60)} · arrive {options.stop.arrivalClock}
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {returnOffer && (
          <section className="rounded-lg border border-green-600 bg-green-50 p-3">
            <p className="text-sm font-semibold">
              Road clear — return to the original route and save ~{Math.round(returnOffer.saveMin)} min?
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
                {i.reports.length > 1 && (
                  <ol className="mt-2 flex flex-col gap-1 border-t border-stone-100 pt-2">
                    {i.reports.map((r, idx) => (
                      <li key={idx} className="text-xs text-stone-600">
                        {formatElapsed(r.t)} · {r.clip} · {pretty(r.stage)}
                      </li>
                    ))}
                  </ol>
                )}
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

      {toast && (
        <p className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-md bg-stone-900 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg">
          {toast.message}
        </p>
      )}
    </main>
  );
}
