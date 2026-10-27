/* eslint-disable @typescript-eslint/no-explicit-any, @next/next/no-img-element */
// Reason: the Google Maps JS API has no bundled types here (`any` stays at
// the Maps boundary and never leaks into sim math), and thumbnails are plain
// <img> tags served from our own cached API route.
'use client';

import { useEffect, useRef, useState } from 'react';

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

const BROWSER_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? '';
const SIM_SEED = 1337;
const YOUR_BASE_MPS = 60 * MPH_TO_MPS;
const SLOW_AHEAD_METERS = 0.5 * METERS_PER_MILE;
const SPEEDS = [1, 10, 30] as const;

interface SimVerdict {
  incident: boolean;
  type: string;
  stage: string;
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
  s: number;
  lat: number;
  lng: number;
  reporterCar: number;
  reports: SimReport[];
  stage: string;
  active: boolean;
  thumbnail: string | null;
  responders: SimVerdict['responders'];
  summary: string;
  type: string;
}

interface ClipOption {
  name: string;
  frameCount: number;
}

interface Hud {
  simTime: number;
  distLeft: number;
  eta: string;
  arrived: boolean;
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

function pinStyle(type: string, active: boolean): { letter: string; color: string } {
  if (!active) return { letter: '✓', color: '#78716c' };
  return TYPE_PIN[type] ?? TYPE_PIN.unknown;
}

function pretty(value: string): string {
  return value.replace(/_/g, ' ');
}

function fmtUSD(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
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

/** Single-canvas car layer: one OverlayView draws every car each frame. */
function createCarsOverlay(
  google: any,
  map: any,
  draw: (canvas: HTMLCanvasElement, projection: any) => void,
): any {
  const overlay = new google.maps.OverlayView();
  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.pointerEvents = 'none';
  overlay.onAdd = () => {
    overlay.getPanes().overlayLayer.appendChild(canvas);
  };
  overlay.draw = () => {
    const projection = overlay.getProjection();
    if (projection) draw(canvas, projection);
  };
  overlay.onRemove = () => {
    canvas.remove();
  };
  overlay.setMap(map);
  return overlay;
}

interface ModalState {
  mode: 'drop' | 'followup';
  /** For drops: snapped route position. For follow-ups: the incident id. */
  s: number;
  lat: number;
  lng: number;
  incidentId: number | null;
}

export default function SimPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'no-key' | 'error' | 'ready'>('loading');
  const [statusError, setStatusError] = useState('');
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(10);
  const [hud, setHud] = useState<Hud>({ simTime: 0, distLeft: 0, eta: '', arrived: false });
  const [incidents, setIncidents] = useState<SimIncident[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [arming, setArming] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [demoOn, setDemoOn] = useState(false);

  const mapRef2 = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const geomRef = useRef<RouteGeom | null>(null);
  const carsRef = useRef<SimCar[]>([]);
  const yourCarRef = useRef({ s: 0, arrived: false });
  const simTimeRef = useRef(0);
  const playingRef = useRef(true);
  const speedRef = useRef<(typeof SPEEDS)[number]>(10);
  const armingRef = useRef(false);
  const incidentsRef = useRef<SimIncident[]>([]);
  const zonesRef = useRef<SlowZone[]>([]);
  const demoRef = useRef({ active: false, fired: 0, incidentId: null as number | null });
  const nextIdRef = useRef(1);
  const googleRef = useRef<any>(null);

  const showToast = (message: string) => {
    setToast({ id: Date.now() + Math.random(), message });
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => {
      setToast((cur) => (cur && Date.now() - cur.id > 0 ? null : cur));
    }, 4500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    armingRef.current = arming;
    if (mapRef2.current) {
      mapRef2.current.setOptions({ draggableCursor: arming ? 'crosshair' : null });
    }
  }, [arming]);
  useEffect(() => {
    incidentsRef.current = incidents;
    zonesRef.current = incidents
      .filter((i) => i.active)
      .flatMap((i) => {
        const mph = stageSpeedMps(i.stage);
        if (mph === null) return [];
        return [{ s0: i.s - SLOW_AHEAD_METERS, s1: i.s, mps: mph * MPH_TO_MPS }];
      });
  }, [incidents]);

  // Map + routes + overlay init (once).
  useEffect(() => {
    if (!BROWSER_KEY) {
      setStatus('no-key');
      return;
    }
    let cancelled = false;
    let map: any = null;
    let overlay: any = null;
    let clickListener: any = null;
    (async () => {
      try {
        await loadMapsApi(BROWSER_KEY);
        if (cancelled) return;
        const google = (window as any).google;
        googleRef.current = google;
        const res = await fetch('/api/sim/routes');
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as {
          main: { encodedPolyline: string };
          detour: { encodedPolyline: string };
        };
        if (cancelled) return;
        const geom = buildRouteGeom(decodePolyline(data.main.encodedPolyline));
        const detourPts = decodePolyline(data.detour.encodedPolyline);
        geomRef.current = geom;
        carsRef.current = createCars(SIM_SEED, geom.length);

        map = new google.maps.Map(mapRef.current, {
          center: { lat: 41.23, lng: -73.0 },
          zoom: 9,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
        mapRef2.current = map;
        new google.maps.Polyline({
          path: geom.points,
          strokeColor: '#0f7668',
          strokeWeight: 5,
          strokeOpacity: 0.9,
          map,
        });
        new google.maps.Polyline({
          path: detourPts,
          strokeOpacity: 0,
          icons: [
            {
              icon: { path: 'M 0,-1 0,1', strokeColor: '#b45309', strokeOpacity: 1, scale: 3 },
              offset: '0',
              repeat: '12px',
            },
          ],
          map,
        });
        const bounds = new google.maps.LatLngBounds();
        for (const p of geom.points) bounds.extend(p);
        map.fitBounds(bounds);

        overlay = createCarsOverlay(google, map, (canvas, projection) => {
          drawCars(canvas, projection);
        });
        overlayRef.current = overlay;

        clickListener = map.addListener('click', (e: any) => {
          if (!armingRef.current || !geomRef.current) return;
          const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
          const snap = nearestOnRoute(geomRef.current, p);
          setArming(false);
          setModal({ mode: 'drop', s: snap.s, lat: snap.point.lat, lng: snap.point.lng, incidentId: null });
        });

        setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setStatusError(err instanceof Error ? err.message : 'Map failed to load.');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      if (clickListener) googleRef.current?.maps?.event?.removeListener(clickListener);
      if (overlay) overlay.setMap(null);
      for (const m of markersRef.current) m.setMap(null);
      markersRef.current = [];
      mapRef2.current = null;
      overlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drawCars = (canvas: HTMLCanvasElement, projection: any) => {
    const geom = geomRef.current;
    const container = mapRef.current;
    if (!geom || !container || !googleRef.current) return;
    const google = googleRef.current;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const dot = (s: number, r: number, fill: string, stroke: string) => {
      const p = pointAt(geom, s);
      const px = projection.fromLatLngToDivPixel(new google.maps.LatLng(p.lat, p.lng));
      if (!px) return;
      ctx.beginPath();
      ctx.arc(px.x, px.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    };
    for (const car of carsRef.current) {
      dot(car.s, 4, car.dir === 1 ? '#1c1917' : '#a8a29e', '#ffffff');
    }
    const you = yourCarRef.current;
    const yp = pointAt(geom, you.s);
    const ypx = projection.fromLatLngToDivPixel(new google.maps.LatLng(yp.lat, yp.lng));
    if (ypx) {
      ctx.beginPath();
      ctx.arc(ypx.x, ypx.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#0f7668';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.font = 'bold 11px system-ui, sans-serif';
      const label = 'YOU';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(ypx.x + 10, ypx.y - 18, tw + 8, 17);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, ypx.x + 14, ypx.y - 5);
    }
  };

  const closestCarId = (lat: number, lng: number): number => {
    const geom = geomRef.current;
    let best = 0;
    let bestD = Infinity;
    for (const c of carsRef.current) {
      if (!geom) break;
      const d = haversineMeters(pointAt(geom, c.s), { lat, lng });
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  };

  const createIncident = (
    point: { s: number; lat: number; lng: number },
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
      s: point.s,
      lat: point.lat,
      lng: point.lng,
      reporterCar: closestCarId(point.lat, point.lng),
      reports: [
        { t, clip, stage: verdict.stage, summary: verdict.summary, incident: verdict.incident },
      ],
      stage: verdict.stage,
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
    if (!verdict.incident) showToast('Follow-up: no incident — marked cleared.');
    setIncidents((prev) =>
      prev.map((i) => {
        if (i.id !== incidentId) return i;
        const stage = verdict.incident ? verdict.stage : 'cleared';
        return {
          ...i,
          reports: [
            ...i.reports,
            { t, clip, stage, summary: verdict.summary, incident: verdict.incident },
          ],
          stage,
          active: verdict.incident,
          summary: verdict.summary,
          type: verdict.type,
          responders: verdict.responders,
        };
      }),
    );
    setSelectedId(incidentId);
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
        const id = createIncident(anchor, ev.clip, data.verdict, t);
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

  const demoAnchorRef = useRef<{ s: number; lat: number; lng: number } | null>(null);

  const onDemoClick = () => {
    if (demoOn) {
      demoRef.current.active = false;
      setDemoOn(false);
      showToast('Demo stopped.');
      return;
    }
    const geom = geomRef.current;
    if (!geom) return;
    simTimeRef.current = 0;
    carsRef.current = createCars(SIM_SEED, geom.length);
    yourCarRef.current = { s: 0, arrived: false };
    setIncidents([]);
    setSelectedId(null);
    const snap = nearestOnRoute(geom, EXIT27);
    demoAnchorRef.current = { s: snap.s, lat: snap.point.lat, lng: snap.point.lng };
    demoRef.current = { active: true, fired: 0, incidentId: null };
    setDemoOn(true);
    setPlaying(true);
    showToast('Demo started: I-95 Exit 27 scenario.');
  };

  // Sim loop: advance traffic on the sim clock, redraw the car canvas.
  useEffect(() => {
    if (status !== 'ready') return;
    let raf = 0;
    let last = performance.now();
    let uiAcc = 1;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dtReal = Math.min(0.1, (now - last) / 1000);
      last = now;
      const geom = geomRef.current;
      if (!geom) return;
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
        for (const car of carsRef.current) stepCar(car, dt, zonesRef.current, geom.length);
        const you = yourCarRef.current;
        if (!you.arrived) {
          you.s += speedInZones(YOUR_BASE_MPS, you.s, zonesRef.current) * dt;
          if (you.s >= geom.length) {
            you.s = geom.length;
            you.arrived = true;
          }
        }
      }
      if (overlayRef.current) overlayRef.current.draw();
      uiAcc += dtReal;
      if (uiAcc >= 0.25) {
        uiAcc = 0;
        const you = yourCarRef.current;
        const proj = projectEta(you.s, zonesRef.current, YOUR_BASE_MPS, geom.length);
        setHud({
          simTime: simTimeRef.current,
          distLeft: proj.milesLeft,
          eta: you.arrived ? 'Arrived' : formatEta(simTimeRef.current, proj.seconds),
          arrived: you.arrived,
        });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Incident pins (rebuilt on change; a handful at most).
  useEffect(() => {
    const google = googleRef.current;
    const map = mapRef2.current;
    if (!google || !map || status !== 'ready') return;
    for (const m of markersRef.current) m.setMap(null);
    markersRef.current = incidents.map((i) => {
      const st = pinStyle(i.type, i.active);
      const marker = new google.maps.Marker({
        position: { lat: i.lat, lng: i.lng },
        map,
        title: i.summary,
        label: { text: st.letter, color: '#ffffff', fontWeight: 'bold' },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: i.id === selectedId ? 14 : 11,
          fillColor: st.color,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      marker.addListener('click', () => setSelectedId(i.id));
      return marker;
    });
  }, [incidents, selectedId, status]);

  if (status === 'no-key') {
    return (
      <main className="mx-auto min-h-screen w-full max-w-6xl bg-white px-4 py-6 text-stone-900">
        <h1 className="text-xl font-semibold">I-95 live simulation</h1>
        <div className="mt-4 max-w-xl space-y-2 rounded-lg border border-amber-500 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Map key missing.</p>
          <p>
            Add <code className="rounded bg-amber-100 px-1">NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY</code>{' '}
            to <code className="rounded bg-amber-100 px-1">.env.local</code>, restart the dev
            server, and reload this page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl bg-white px-4 py-6 text-stone-900">
      <header>
        <h1 className="text-xl font-semibold">I-95 live simulation</h1>
        <p className="mt-1 text-sm text-stone-600">
          New Haven → Times Square. Drop incident reports on real AI verdicts.
        </p>
      </header>

      {status === 'loading' && <p className="mt-4 text-sm text-stone-600">Loading map and routes…</p>}
      {status === 'error' && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {statusError}
        </p>
      )}

      {(status === 'loading' || status === 'ready') && (
        <div className="mt-4 flex flex-col gap-4 lg:flex-row">
          <div className="min-w-0 lg:basis-[70%]">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPlaying((v) => !v)}
                className="min-h-[44px] rounded-md border border-stone-300 px-4 text-sm font-medium hover:bg-stone-50"
              >
                {playing ? 'Pause' : 'Play'}
              </button>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpeed(s)}
                  className={`min-h-[44px] rounded-md border px-3 text-sm tabular-nums ${
                    speed === s
                      ? 'border-teal-700 bg-teal-700 text-white'
                      : 'border-stone-300 hover:bg-stone-50'
                  }`}
                >
                  {s}x
                </button>
              ))}
              <span className="text-sm tabular-nums text-stone-600">
                {formatElapsed(hud.simTime)}
              </span>
              <button
                type="button"
                onClick={() => setArming((v) => !v)}
                disabled={status !== 'ready'}
                className="min-h-[44px] rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {arming ? 'Cancel' : 'Drop incident'}
              </button>
              <button
                type="button"
                onClick={onDemoClick}
                disabled={status !== 'ready'}
                className="min-h-[44px] rounded-md border border-teal-700 px-4 text-sm font-medium text-teal-800 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {demoOn ? 'Stop demo' : 'Play I-95 demo'}
              </button>
            </div>
            {arming && (
              <p className="mt-2 text-sm font-medium text-teal-800">
                Click on the map to place the incident.
              </p>
            )}
            <div
              ref={mapRef}
              className="mt-2 h-[55vh] w-full rounded-md border border-stone-200 bg-stone-100 lg:h-[70vh]"
            />
          </div>

          <div className="min-w-0 space-y-4 lg:basis-[30%]">
            <section className="rounded-lg border border-stone-200 p-4">
              <h2 className="text-sm font-semibold">Your car → Times Square</h2>
              <p className="mt-1 text-sm tabular-nums text-stone-700">
                {hud.arrived ? 'Arrived' : `${hud.distLeft.toFixed(1)} mi left · ETA ${hud.eta}`}
              </p>
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-semibold">Incidents ({incidents.length})</h2>
              {incidents.length === 0 && (
                <p className="text-sm text-stone-500">
                  No incidents yet. Drop one on the map or play the demo.
                </p>
              )}
              {incidents.map((i) => {
                const st = pinStyle(i.type, i.active);
                return (
                  <article
                    key={i.id}
                    onClick={() => setSelectedId(i.id)}
                    className={`space-y-2 rounded-lg border p-4 ${
                      i.id === selectedId ? 'border-teal-700 ring-1 ring-teal-700' : 'border-stone-200'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                        style={{ backgroundColor: st.color }}
                      >
                        {st.letter}
                      </span>
                      <p className="text-sm font-medium leading-snug">{i.summary}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 text-stone-700">
                        stage: {pretty(i.stage)}
                      </span>
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 text-stone-700">
                        type: {pretty(i.type)}
                      </span>
                      {!i.active && (
                        <span className="rounded-full bg-stone-200 px-2.5 py-1 text-stone-600">
                          cleared
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {(
                        [
                          ['police', 'Police'],
                          ['ambulance', 'Ambulance'],
                          ['fire', 'Fire'],
                          ['towTruck', 'Tow'],
                        ] as const
                      ).map(([key, label]) => (
                        <span
                          key={key}
                          className={`rounded-full border px-2.5 py-1 ${
                            i.responders[key]
                              ? 'border-teal-700 bg-teal-50 text-teal-900'
                              : 'border-stone-200 bg-stone-50 text-stone-500'
                          }`}
                        >
                          {label}
                          {!i.responders[key] && <span className="opacity-75"> · none</span>}
                        </span>
                      ))}
                    </div>
                    {i.thumbnail && (
                      <img
                        src={i.thumbnail}
                        alt="Evidence still from the incident report"
                        className="w-full rounded-md"
                        loading="lazy"
                      />
                    )}
                    <div>
                      <h3 className="text-xs font-semibold text-stone-500">Reports</h3>
                      <ul className="mt-1 space-y-1 text-xs text-stone-700">
                        {i.reports.map((r, idx) => (
                          <li key={idx}>
                            <span className="tabular-nums">{formatElapsed(r.t)}</span> · {r.clip} ·{' '}
                            {pretty(r.stage)} — {r.summary}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {i.active && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setModal({ mode: 'followup', s: i.s, lat: i.lat, lng: i.lng, incidentId: i.id });
                        }}
                        className="min-h-[44px] w-full rounded-md border border-stone-300 px-3 text-sm font-medium hover:bg-stone-50"
                      >
                        Add follow-up report
                      </button>
                    )}
                  </article>
                );
              })}
            </section>
          </div>
        </div>
      )}

      {modal && (
        <ClipModal
          title={modal.mode === 'drop' ? 'Report incident' : 'Follow-up report'}
          subtitle={
            modal.mode === 'drop'
              ? `Snapped ${(modal.s / METERS_PER_MILE).toFixed(1)} mi from New Haven`
              : `On incident #${modal.incidentId}`
          }
          onClose={() => setModal(null)}
          onDone={(clip, verdict) => {
            if (modal.mode === 'drop') {
              createIncident(
                { s: modal.s, lat: modal.lat, lng: modal.lng },
                clip,
                verdict,
                simTimeRef.current,
              );
            } else if (modal.incidentId !== null) {
              applyFollowup(modal.incidentId, clip, verdict, simTimeRef.current);
            }
            setModal(null);
          }}
        />
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-[60] max-w-[90vw] -translate-x-1/2 rounded-md bg-stone-900 px-4 py-3 text-center text-sm text-white"
        >
          {toast.message}
        </div>
      )}
    </main>
  );
}

function ClipModal({
  title,
  subtitle,
  onClose,
  onDone,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  onDone: (clip: string, verdict: SimVerdict) => void;
}) {
  const [clips, setClips] = useState<ClipOption[]>([]);
  const [selected, setSelected] = useState('');
  const [probe, setProbe] = useState<{ estimateUSD: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/lab/clips');
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as { clips: ClipOption[] };
        setClips(data.clips.filter((c) => !c.name.startsWith('synth-')));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load clips.');
      }
    })();
  }, []);

  const onSelect = async (name: string) => {
    setSelected(name);
    setProbe(null);
    setError(null);
    try {
      const res = await fetch(`/api/sim/report?clip=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(await readError(res));
      setProbe((await res.json()) as { estimateUSD: number });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cost check failed.');
    }
  };

  const onConfirm = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sim/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clip: selected }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { verdict: SimVerdict };
      onDone(selected, data.verdict);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Report failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-stone-600">{subtitle}</p>
        {error && (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <ul className="mt-3 space-y-2">
          {clips.map((c) => (
            <li key={c.name}>
              <button
                type="button"
                onClick={() => void onSelect(c.name)}
                className={`block min-h-[44px] w-full rounded-md border px-3 py-2 text-left text-sm ${
                  selected === c.name
                    ? 'border-teal-700 bg-teal-50'
                    : 'border-stone-200 hover:bg-stone-50'
                }`}
              >
                <span className="font-medium">{c.name}</span>
                <span className="ml-2 tabular-nums text-stone-500">{c.frameCount} frames</span>
              </button>
            </li>
          ))}
        </ul>
        {selected && probe && (
          <p className="mt-3 text-sm tabular-nums text-stone-600">
            {probe.estimateUSD === 0
              ? 'Cached results — this report costs $0.'
              : `This report will cost ≈${fmtUSD(probe.estimateUSD)}.`}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={!selected || !probe || busy}
            className="min-h-[44px] flex-1 rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Analyzing…' : selected ? `Report with ${selected}` : 'Pick a clip'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-md border border-stone-300 px-4 text-sm font-medium hover:bg-stone-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
