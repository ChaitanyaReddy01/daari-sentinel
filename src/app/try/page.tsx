'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { upload } from '@vercel/blob/client';

import { displayClearance, type AgentAssessment } from '@/lib/agent-guard';
import type { VerdictCheck } from '@/lib/checks';
import { confidencePhrase, stagePhrase, typePhrase } from '@/lib/present';
import type { Verdict } from '@/lib/verdict';

const MAX_SECONDS = 30;
const MAX_BYTES = 50 * 1024 * 1024;
const STEP_TIMEOUT_MS = 55000;
const STILL_FRACS = [0.2, 0.45, 0.7, 0.9];
const BROWSER_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? '';
/** Post map bounds mirror the server's corridor (it re-validates). */
const CORRIDOR = { minLat: 40.45, maxLat: 41.8, minLng: -74.35, maxLng: -71.75 };
/** Client still budget: decoded bytes must stay under the 80 KB server cap. */
const POST_STILL_MAX_BYTES = 76 * 1024;

interface StillOut {
  index: number;
  seconds: number;
  width: number;
  height: number;
  jpeg: string;
}

interface TryBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  id: string;
  c: number | null;
}

interface DetectStill {
  index: number;
  seconds: number;
  width: number;
  height: number;
  counts: Record<string, number>;
  boxes: Record<string, TryBox[]>;
}

interface StoredAssessment {
  assessment: AgentAssessment;
  source: 'muse-wonder' | 'fallback table';
  notes: string[];
  estUSD: number;
}

type StepKey = 'upload' | 'start' | 'quicklook' | 'detect' | 'verdict' | 'assess' | 'finish';
type StepStatus = 'idle' | 'busy' | 'done' | 'error';

interface QuicklookOut {
  flag: 'clear' | 'suspicious';
  reasons: string[];
  confidence: number;
}

const STEP_LABELS: Record<StepKey, string> = {
  upload: 'Uploading clip',
  start: 'Reserving a try',
  quicklook: 'Quick look at one still',
  detect: 'Finding objects on 4 stills',
  verdict: 'Reading the scene',
  assess: 'Tracking the incident',
  finish: 'Deleting the clip',
};

/** Privacy concepts: blurred, never boxed, labeled or counted. */
const SENSITIVE_CONCEPTS = new Set(['face', 'license plate']);

function loadStillImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode still.'));
    img.src = src;
  });
}

/**
 * Blur every sensitive box (padded 20%) and return a JPEG data URL. The
 * source image is decoded off-DOM and never rendered.
 */
async function blurStill(jpeg: string, boxes: TryBox[]): Promise<string> {
  const img = await loadStillImage(jpeg);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');
  ctx.drawImage(img, 0, 0);
  for (const b of boxes) {
    const padX = (b.x2 - b.x1) * 0.2;
    const padY = (b.y2 - b.y1) * 0.2;
    const sx = Math.max(0, Math.floor(b.x1 - padX));
    const sy = Math.max(0, Math.floor(b.y1 - padY));
    const sw = Math.min(canvas.width - sx, Math.ceil(b.x2 + padX) - sx);
    const sh = Math.min(canvas.height - sy, Math.ceil(b.y2 + padY) - sy);
    if (sw <= 0 || sh <= 0) continue;
    const off = document.createElement('canvas');
    off.width = sw;
    off.height = sh;
    const octx = off.getContext('2d');
    if (!octx) continue;
    octx.filter = `blur(${Math.max(12, Math.round(Math.min(sw, sh) * 0.25))}px)`;
    octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    ctx.drawImage(off, sx, sy);
  }
  return canvas.toDataURL('image/jpeg', 0.85);
}

function BlurredStill({ jpeg, boxes, alt }: { jpeg: string; boxes: TryBox[]; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const boxesKey = useMemo(() => JSON.stringify(boxes), [boxes]);
  useEffect(() => {
    let live = true;
    blurStill(jpeg, JSON.parse(boxesKey) as TryBox[])
      .then((u) => {
        if (live) setSrc(u);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [jpeg, boxesKey]);
  if (failed) {
    return <div className="flex h-32 items-center justify-center rounded bg-stone-100 text-xs text-stone-500">Still unavailable</div>;
  }
  if (!src) {
    return <div className="flex h-32 items-center justify-center rounded bg-stone-100 text-xs text-stone-500">Blurring still…</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className="h-auto w-full rounded" />;
}

const BOX_COLORS: Record<string, string> = {
  car: '#fbbf24',
  truck: '#fb923c',
  'police car': '#60a5fa',
  ambulance: '#f87171',
  'fire truck': '#ef4444',
  'tow truck': '#a78bfa',
  person: '#f0abfc',
  'safety vest': '#4ade80',
};

function validateFile(f: File): string | null {
  const name = f.name.toLowerCase();
  const okType =
    f.type === 'video/mp4' ||
    f.type === 'video/quicktime' ||
    name.endsWith('.mp4') ||
    name.endsWith('.mov');
  if (!okType) return 'Please pick an mp4 or mov file.';
  if (f.size > MAX_BYTES) {
    return `File is ${(f.size / 1048576).toFixed(0)} MB — max 50 MB.`;
  }
  return null;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === 'string' ? data.error : `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/**
 * The blob SDK replaces any token-route failure with a generic message, so
 * on upload failure we re-ask the token route directly to recover the
 * server's real message (kill switch, quota, budget). Read-only for quota.
 */
async function tokenRouteError(pathname: string): Promise<string | null> {
  try {
    const res = await fetch('/api/try/upload-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'blob.generate-client-token',
        payload: { pathname, clientPayload: null, multipart: false },
      }),
    });
    if (res.ok) return null;
    return await readError(res);
  } catch {
    return null;
  }
}

async function uploadClip(pathname: string, file: File): Promise<string> {
  try {
    const res = await upload(pathname, file, {
      access: 'public',
      handleUploadUrl: '/api/try/upload-token',
    });
    return res.url;
  } catch (err) {
    const serverMessage = await tokenRouteError(pathname);
    throw new Error(
      serverMessage ?? (err instanceof Error ? err.message : 'Upload failed.'),
    );
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STEP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(await readError(res));
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Timed out — the server was slow. Retry this step.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function loadDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const d = video.duration;
      URL.revokeObjectURL(url);
      if (!Number.isFinite(d) || d <= 0) reject(new Error('Could not read the clip duration.'));
      else resolve(d);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read this video file.'));
    };
    video.src = url;
  });
}

function extractStills(file: File, duration: number): Promise<StillOut[]> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode this video file.'));
    };
    video.onloadedmetadata = () => {
      const scale = Math.min(1, 1280 / video.videoWidth);
      const w = Math.max(16, Math.round(video.videoWidth * scale));
      const h = Math.max(16, Math.round(video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas is not available in this browser.'));
        return;
      }
      const out: StillOut[] = [];
      let i = 0;
      const grab = () => {
        if (i >= STILL_FRACS.length) {
          URL.revokeObjectURL(url);
          resolve(out);
          return;
        }
        const t = Math.min(STILL_FRACS[i] * duration, Math.max(0, duration - 0.1));
        const onSeek = () => {
          video.removeEventListener('seeked', onSeek);
          ctx.drawImage(video, 0, 0, w, h);
          out.push({ index: i, seconds: t, width: w, height: h, jpeg: canvas.toDataURL('image/jpeg', 0.85) });
          i += 1;
          grab();
        };
        video.addEventListener('seeked', onSeek);
        video.currentTime = t;
      };
      grab();
    };
    video.src = url;
  });
}

function stillPayload(s: StillOut) {
  return {
    index: s.index,
    seconds: s.seconds,
    width: s.width,
    height: s.height,
    jpegBase64: s.jpeg.replace(/^data:image\/jpeg;base64,/, ''),
  };
}

let postMapsPromise: Promise<void> | null = null;

/** Minimal Maps loader for the post modal (same pattern as /sim). */
function loadPostMapsApi(key: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window.'));
  const w = window as unknown as { google?: { maps?: unknown }; gm_authFailure?: () => void };
  if (w.google?.maps) return Promise.resolve();
  if (postMapsPromise) return postMapsPromise;
  postMapsPromise = new Promise((resolve, reject) => {
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
  return postMapsPromise;
}

/** Shrink a blurred still until it fits the board's still budget. */
async function compressStill(dataUrl: string): Promise<string> {
  const img = await loadStillImage(dataUrl);
  for (const width of [640, 480, 320]) {
    const scale = Math.min(1, width / img.naturalWidth);
    const w = Math.max(16, Math.round(img.naturalWidth * scale));
    const h = Math.max(16, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable.');
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of [0.8, 0.65, 0.5, 0.35]) {
      const out = canvas.toDataURL('image/jpeg', q);
      const bytes = Math.floor((out.length - 'data:image/jpeg;base64,'.length) * 0.75);
      if (bytes <= POST_STILL_MAX_BYTES) return out;
    }
  }
  throw new Error('Could not shrink a still under 80 KB.');
}

function samSummaryFor(detect: DetectStill[]): string {
  const concepts = ['car', 'truck', 'police car', 'ambulance', 'fire truck', 'tow truck', 'person', 'safety vest'];
  const parts: string[] = [];
  for (const c of concepts) {
    const n = Math.max(0, ...detect.map((s) => s.counts[c] ?? 0));
    if (n > 0) parts.push(`${n} ${c}${n === 1 ? '' : 's'} (max over 4 stills)`);
  }
  return parts.length === 0 ? 'Object tracker found nothing on the 4 stills.' : `Object tracker found: ${parts.join(', ')}.`;
}

const IDLE_STEPS: Record<StepKey, StepStatus> = {
  upload: 'idle',
  start: 'idle',
  quicklook: 'idle',
  detect: 'idle',
  verdict: 'idle',
  assess: 'idle',
  finish: 'idle',
};

interface PostModalProps {
  tryId: string;
  kind: 'incident' | 'clear';
  stills: StillOut[];
  detect: DetectStill[] | null;
  onClose: () => void;
  onPosted: (road: string | null) => void;
}

/** Minimal Maps surface used by the post modal (no @types/google.maps). */
interface PostMapClick {
  latLng?: { lat: () => number; lng: () => number };
}
interface PostMap {
  fitBounds: (bounds: object) => void;
  panTo: (p: { lat: number; lng: number }) => void;
  setZoom: (z: number) => void;
  addListener: (event: string, fn: (e: PostMapClick) => void) => { remove: () => void };
}
interface PostMarker {
  setPosition: (p: { lat: number; lng: number }) => void;
}
interface PostMapsApi {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => PostMap;
  Marker: new (opts: { map: PostMap }) => PostMarker;
  LatLngBounds: new (sw: { lat: number; lng: number }, ne: { lat: number; lng: number }) => object;
}

/** Post-to-board map: tap to place (or use GPS), preview the road snap. */
function PostMapModal({ tryId, kind, stills, detect, onClose, onPosted }: PostModalProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<PostMap | null>(null);
  const markerObj = useRef<PostMarker | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [snap, setSnap] = useState<
    | { status: 'idle' }
    | { status: 'busy' }
    | { status: 'ok'; road: string; distM: number }
    | { status: 'offroad' }
    | { status: 'outside' }
  >({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!BROWSER_KEY) {
      setMapError('Map unavailable (no browser key).');
      return;
    }
    let cancelled = false;
    let clickListener: { remove: () => void } | null = null;
    (async () => {
      try {
        await loadPostMapsApi(BROWSER_KEY);
        if (cancelled || !mapRef.current) return;
        const google = (window as unknown as { google: { maps: PostMapsApi } }).google;
        const map = new google.maps.Map(mapRef.current, {
          center: { lat: (CORRIDOR.minLat + CORRIDOR.maxLat) / 2, lng: (CORRIDOR.minLng + CORRIDOR.maxLng) / 2 },
          zoom: 8,
          streetViewControl: false,
          fullscreenControl: false,
        });
        map.fitBounds(
          new google.maps.LatLngBounds(
            { lat: CORRIDOR.minLat, lng: CORRIDOR.minLng },
            { lat: CORRIDOR.maxLat, lng: CORRIDOR.maxLng },
          ),
        );
        mapObj.current = map;
        clickListener = map.addListener('click', (e: PostMapClick) => {
          const lat = e?.latLng?.lat?.();
          const lng = e?.latLng?.lng?.();
          if (typeof lat === 'number' && typeof lng === 'number') place(lat, lng);
        });
      } catch (err) {
        if (!cancelled) setMapError(err instanceof Error ? err.message : 'Map failed to load.');
      }
    })();
    return () => {
      cancelled = true;
      if (clickListener) clickListener.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!loc) {
      setSnap({ status: 'idle' });
      return;
    }
    let live = true;
    setSnap({ status: 'busy' });
    (async () => {
      try {
        const res = await fetch(`/api/board/snap?lat=${loc.lat}&lng=${loc.lng}`);
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as
          | { ok: true; road: string; distM: number }
          | { ok: false; reason: 'outside' | 'offroad' };
        if (!live) return;
        if (data.ok) setSnap({ status: 'ok', road: data.road, distM: data.distM });
        else setSnap({ status: data.reason === 'outside' ? 'outside' : 'offroad' });
      } catch {
        if (live) setSnap({ status: 'idle' });
      }
    })();
    return () => {
      live = false;
    };
  }, [loc]);

  const place = (lat: number, lng: number) => {
    setError(null);
    setLoc({ lat, lng });
    const w = window as unknown as { google?: { maps?: PostMapsApi } };
    const map = mapObj.current;
    const maps = w.google?.maps;
    if (maps && map) {
      if (!markerObj.current) {
        markerObj.current = new maps.Marker({ map });
      }
      markerObj.current.setPosition({ lat, lng });
    }
  };

  const useMyLocation = () => {
    setError(null);
    if (!('geolocation' in navigator)) {
      setError('Geolocation is not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        place(pos.coords.latitude, pos.coords.longitude);
        mapObj.current?.panTo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        mapObj.current?.setZoom(12);
      },
      () => setError('Could not read your location. Tap the map instead.'),
      { timeout: 8000, maximumAge: 60000 },
    );
  };

  const post = async () => {
    if (!loc || snap.status !== 'ok' || busy) return;
    setBusy(true);
    setError(null);
    try {
      let payload: { seconds: number; jpeg: string }[] = [];
      if (kind === 'incident') {
        // The same blurred canvases the user saw, shrunk under 80 KB each.
        const ranked = [...stills]
          .map((st) => {
            const d = detect?.find((x) => x.index === st.index);
            const boxes = d ? Object.values(d.boxes).flat().length : 0;
            return { st, d, boxes };
          })
          .sort((a, b) => b.boxes - a.boxes)
          .slice(0, 2);
        payload = await Promise.all(
          ranked.map(async ({ st, d }) => {
            const sensitive = d ? [...(d.boxes.face ?? []), ...(d.boxes['license plate'] ?? [])] : [];
            return { seconds: st.seconds, jpeg: await compressStill(await blurStill(st.jpeg, sensitive)) };
          }),
        );
      }
      const data = await postJson<{ posted: boolean; attached: boolean; road?: string }>(
        '/api/board',
        { tryId, lat: loc.lat, lng: loc.lng, stills: payload },
      );
      if (!data.posted) throw new Error('Post failed.');
      onPosted(data.road ?? (snap.status === 'ok' ? snap.road : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Post failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={kind === 'incident' ? 'Post to the live map' : 'Post all-clear'}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-3"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {kind === 'incident' ? 'Where did your camera see it?' : 'Where is the road clear?'}
            </p>
            <p className="text-xs text-stone-600">Tap the map or use your location.</p>
          </div>
          <button
            type="button"
            aria-label="Close post map"
            onClick={onClose}
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border border-stone-300 text-lg font-semibold hover:bg-stone-100"
          >
            ✕
          </button>
        </div>
        {mapError ? (
          <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
            {mapError}
          </p>
        ) : (
          <div ref={mapRef} className="mt-2 h-64 w-full rounded-md border border-stone-200" />
        )}
        <button
          type="button"
          onClick={useMyLocation}
          className="mt-2 min-h-[44px] w-full rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
        >
          Use my location
        </button>
        <div aria-live="polite" className="mt-2 min-h-[20px] text-sm">
          {snap.status === 'busy' && <p className="text-stone-600">Checking the road…</p>}
          {snap.status === 'ok' && (
            <p className="text-stone-800">
              Snapped to {snap.road} ({snap.distM} m away).
            </p>
          )}
          {snap.status === 'offroad' && (
            <p className="font-semibold text-amber-800">
              No major road within 300 m — pick a spot on a road.
            </p>
          )}
          {snap.status === 'outside' && (
            <p className="font-semibold text-amber-800">That spot is outside the CT–NYC corridor.</p>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-1 text-sm font-semibold text-red-700">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={post}
          disabled={snap.status !== 'ok' || busy}
          className="mt-2 min-h-[44px] w-full rounded-md bg-[#F2B544] px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-[#F6C453] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Posting…' : kind === 'incident' ? 'Post to the live map' : 'Post all-clear'}
        </button>
      </div>
    </div>
  );
}

export default function TryPage() {
  const [ownerNote, setOwnerNote] = useState<string | null>(null);

  // Owner pass exchange: POSTs the pass (never logged), stores nothing in JS.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pass = q.get('owner');
    if (!pass) return;
    q.delete('owner');
    const rest = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    fetch('/api/try/owner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pass }),
    })
      .then(async (res) => {
        setOwnerNote(res.ok ? 'Owner pass accepted.' : 'Wrong owner pass.');
      })
      .catch(() => {
        setOwnerNote('Could not verify the owner pass.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState(IDLE_STEPS);
  const [error, setError] = useState<string | null>(null);
  const [tryId, setTryId] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [stills, setStills] = useState<StillOut[]>([]);
  const [detect, setDetect] = useState<DetectStill[] | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checks, setChecks] = useState<VerdictCheck[]>([]);
  const [roadScene, setRoadScene] = useState(true);
  const [stored, setStored] = useState<StoredAssessment | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);
  const [quicklook, setQuicklook] = useState<QuicklookOut | null>(null);
  const [timings, setTimings] = useState<Partial<Record<StepKey, number>>>({});
  const [fullStarted, setFullStarted] = useState(false);
  const [postOpen, setPostOpen] = useState<'incident' | 'clear' | null>(null);
  const [postDone, setPostDone] = useState<string | null>(null);
  // Step 10: result details collapse behind "Show details" once finished.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const setStep = (k: StepKey, v: StepStatus) => setSteps((s) => ({ ...s, [k]: v }));

  async function run<T>(key: StepKey, fn: () => Promise<T>): Promise<T> {
    setStep(key, 'busy');
    const t0 = performance.now();
    try {
      const out = await fn();
      setStep(key, 'done');
      setTimings((t) => ({ ...t, [key]: performance.now() - t0 }));
      return out;
    } catch (err) {
      setStep(key, 'error');
      throw err;
    }
  }

  async function pick(f: File | undefined) {
    reset(false);
    if (!f) return;
    const bad = validateFile(f);
    if (bad) {
      setError(bad);
      return;
    }
    setFile(f);
    try {
      const d = await loadDuration(f);
      if (d > MAX_SECONDS) {
        setError(`Clip is ${d.toFixed(0)} s — max ${MAX_SECONDS} s.`);
        setFile(null);
        return;
      }
      setDuration(d);
      setStills(await extractStills(f, d));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this video.');
      setFile(null);
    }
  }

  async function runFull(id: string) {
    setFullStarted(true);
    // Level 2 in parallel: verdict waits server-side for the SAM data, so an
    // empty samSummary lets it use the full hints from the detect step.
    const [, ver] = await Promise.all([
      run('detect', async () => {
        const data = await postJson<{ stills: DetectStill[] }>('/api/try/detect', {
          tryId: id,
          stills: stills.map(stillPayload),
        });
        setDetect(data.stills);
        return data.stills;
      }),
      run('verdict', async () => {
        const data = await postJson<{ verdict: Verdict; checks: VerdictCheck[]; roadScene: boolean }>(
          '/api/try/verdict',
          { tryId: id, samSummary: '' },
        );
        setVerdict(data.verdict);
        setChecks(data.checks);
        setRoadScene(data.roadScene);
        return data;
      }),
    ]);
    // Level 3 only when a real incident was found (new try ⇒ new incident).
    if (ver.roadScene && ver.verdict.incident) {
      await run('assess', async () => {
        const data = await postJson<{ stored: StoredAssessment }>('/api/try/assess', { tryId: id });
        setStored(data.stored);
      });
    } else {
      setStep('assess', 'done');
    }
    await run('finish', async () => {
      const data = await postJson<{ cost: number }>('/api/try/finish', { tryId: id });
      setCost(data.cost);
    });
    setFinished(true);
  }

  async function startFlow() {
    if (!file || duration === null || stills.length !== 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = await run('upload', async () => {
        const blobUrl = await uploadClip(`tries/${file.name}`, file);
        setBlobUrl(blobUrl);
        return blobUrl;
      });
      const id = await run('start', async () => {
        const data = await postJson<{ tryId: string }>('/api/try/start', {
          blobUrl: url,
          fileName: file.name,
          durationSec: duration,
        });
        setTryId(data.tryId);
        return data.tryId;
      });
      const ql = await run('quicklook', async () => {
        const data = await postJson<{ flag: 'clear' | 'suspicious'; reasons: string[]; confidence: number; cost: number }>(
          '/api/try/quicklook',
          { tryId: id, still: stillPayload(stills[1]) },
        );
        setQuicklook({ flag: data.flag, reasons: data.reasons, confidence: data.confidence });
        setCost(data.cost);
        return data;
      });
      // Level 1 clear: stop here; the try stays open for "run full anyway".
      if (ql.flag === 'suspicious') {
        await runFull(id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function runFullAnyway() {
    if (!tryId || busy || fullStarted) return;
    setBusy(true);
    setError(null);
    try {
      await runFull(tryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function retryStep(key: StepKey) {
    if (busy || !tryId || !blobUrl) return;
    setBusy(true);
    setError(null);
    try {
      if (key === 'quicklook') {
        if (stills.length !== 4) throw new Error('Pick a clip first.');
        await run('quicklook', async () => {
          const data = await postJson<{ flag: 'clear' | 'suspicious'; reasons: string[]; confidence: number; cost: number }>(
            '/api/try/quicklook',
            { tryId, still: stillPayload(stills[1]) },
          );
          setQuicklook({ flag: data.flag, reasons: data.reasons, confidence: data.confidence });
          setCost(data.cost);
          if (data.flag === 'suspicious') await runFull(tryId);
        });
      } else if (key === 'detect') {
        await run('detect', async () => {
          const data = await postJson<{ stills: DetectStill[] }>('/api/try/detect', {
            tryId,
            stills: stills.map(stillPayload),
          });
          setDetect(data.stills);
          return data.stills;
        });
      } else if (key === 'verdict') {
        if (!detect) throw new Error('Run detection first.');
        await run('verdict', async () => {
          const data = await postJson<{ verdict: Verdict; checks: VerdictCheck[]; roadScene: boolean }>(
            '/api/try/verdict',
            { tryId, samSummary: samSummaryFor(detect) },
          );
          setVerdict(data.verdict);
          setChecks(data.checks);
          setRoadScene(data.roadScene);
        });
      } else if (key === 'assess') {
        await run('assess', async () => {
          const data = await postJson<{ stored: StoredAssessment }>('/api/try/assess', { tryId });
          setStored(data.stored);
        });
      } else if (key === 'finish') {
        await run('finish', async () => {
          const data = await postJson<{ cost: number }>('/api/try/finish', { tryId });
          setCost(data.cost);
          setFinished(true);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed.');
    } finally {
      setBusy(false);
    }
  }

  function reset(clearFile: boolean) {
    if (clearFile) {
      setFile(null);
      setDuration(null);
      setStills([]);
      if (inputRef.current) inputRef.current.value = '';
    }
    setSteps(IDLE_STEPS);
    setError(null);
    setTryId(null);
    setBlobUrl(null);
    setDetect(null);
    setVerdict(null);
    setChecks([]);
    setRoadScene(true);
    setStored(null);
    setCost(null);
    setFinished(false);
    setQuicklook(null);
    setTimings({});
    setFullStarted(false);
    setPostOpen(null);
    setPostDone(null);
    setDetailsOpen(false);
  }

  async function discardAndReset() {
    if (tryId && !finished) {
      try {
        await postJson('/api/try/finish', { tryId });
      } catch {
        /* sweep deletes it within the hour */
      }
    }
    reset(true);
  }

  async function addToSim() {
    if (!verdict || !stored || !blobUrl || duration === null || cost === null || !detect) return;
    try {
      // Blurred images only: the unblurred stills never leave this page.
      const blurred = await Promise.all(
        stills.map(async (st) => {
          const d = detect.find((x) => x.index === st.index);
          const sensitive = d ? [...(d.boxes.face ?? []), ...(d.boxes['license plate'] ?? [])] : [];
          return { seconds: st.seconds, jpeg: await blurStill(st.jpeg, sensitive) };
        }),
      );
      sessionStorage.setItem(
        'try-incident',
        JSON.stringify({
          verdict,
          checks,
          stored,
          cost,
          clipSeconds: Math.round(duration),
          stills: blurred,
        }),
      );
    } catch {
      setError('Could not pass the result to /sim (storage full).');
      return;
    }
    window.location.href = '/sim?try=1';
  }

  const cleared = stored ? displayClearance(stored.assessment, 0, false) : null;
  const running = busy || Object.values(steps).some((s) => s === 'busy');
  const canRun = file && duration !== null && stills.length === 4 && !running && !finished && !tryId;
  const totalMs = Object.values(timings).reduce((a, b) => a + (b ?? 0), 0);
  const fmtCost = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
  // A check is running while an analysis step is busy: scan the still.
  const scanning =
    steps.quicklook === 'busy' ||
    steps.detect === 'busy' ||
    steps.verdict === 'busy' ||
    steps.assess === 'busy';

  // Step 10: one result headline; details open live, then collapse.
  useEffect(() => {
    if (running) {
      setDetailsOpen(true);
    } else if (finished || (quicklook && quicklook.flag === 'clear' && !fullStarted)) {
      setDetailsOpen(false);
    }
  }, [running, finished, quicklook, fullStarted]);
  type HeadlineKind = 'clear' | 'notroad' | 'normal' | 'incident' | null;
  let headlineKind: HeadlineKind = null;
  if (quicklook && quicklook.flag === 'clear' && !fullStarted) headlineKind = 'clear';
  else if (verdict && !roadScene) headlineKind = 'notroad';
  else if (verdict && roadScene && verdict.incident) headlineKind = 'incident';
  else if (verdict && roadScene && !verdict.incident && finished) headlineKind = 'normal';
  const incidentHeadline =
    headlineKind === 'incident' && verdict
      ? (() => {
          const names = (
            [
              ['police', 'police'],
              ['ambulance', 'ambulance'],
              ['fire', 'fire crew'],
              ['towTruck', 'tow truck'],
            ] as const
          )
            .filter(([key]) => verdict.responders[key])
            .map(([, name]) => name);
          const tail =
            names.length > 0
              ? ` · ${names.join(', ')} on scene`
              : (() => {
                  const s = stagePhrase(verdict.stage);
                  return s ? ` · ${s}` : '';
                })();
          return `${typePhrase(verdict.type)} detected${tail}`;
        })()
      : '';
  const hasDetails =
    detect !== null ||
    verdict !== null ||
    stored !== null ||
    finished ||
    quicklook !== null;
  // Scan thumb while a check runs (the user's own still, shown back to them).
  // eslint-disable-next-line @next/next/no-img-element
  const scanImg = (src: string) => <img src={src} alt="" aria-hidden="true" className="h-auto w-full rounded" />;

  return (
    <main className="app-root mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold leading-[1.1] tracking-tight text-stone-900">Try your own clip</h1>
        <p className="text-base text-stone-600 sm:text-[17px]">
          Upload a short road clip (mp4 or mov, max 30 s, max 50 MB). We find the objects,
          read the scene and track the incident — then delete the clip.
        </p>
        {ownerNote && (
          <p role="status" className="text-sm font-semibold text-stone-700">
            {ownerNote}
          </p>
        )}
      </header>

      <div className="rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-700">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">How it works</p>
        <ol className="mt-2 flex flex-col gap-1">
          <li>1. Upload a short road clip (mp4/mov, max 30 s).</li>
          <li>2. Normal traffic stops at a quick check; incidents get a full check, with faces and plates blurred.</li>
          <li>3. If it’s an incident, “Post to the live map” and pick where it was filmed.</li>
        </ol>
      </div>

      <section className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
        <label
          htmlFor="clip"
          className="flex min-h-[44px] cursor-pointer items-center justify-center rounded-md bg-[#F2B544] px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-[#F6C453]"
        >
          {file ? file.name : 'Pick a video'}
        </label>
        <input
          ref={inputRef}
          id="clip"
          type="file"
          accept="video/mp4,video/quicktime,.mp4,.mov"
          className="sr-only"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <p className="text-xs text-stone-500">
          Clips are analyzed and deleted within an hour. Don&apos;t upload footage with
          personal information.
        </p>
        {file && duration !== null && (
          <p className="text-sm text-stone-700">
            {file.name} · {duration.toFixed(1)} s · {(file.size / 1048576).toFixed(1)} MB
            {stills.length === 4 ? ' · 4 stills ready' : ' · reading stills…'}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canRun}
            onClick={startFlow}
            className="min-h-[44px] flex-1 rounded-md bg-[#F2B544] px-4 py-2 text-sm font-semibold text-stone-950 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[#F6C453]"
          >
            {running ? 'Analyzing…' : finished ? 'Analyzed' : quicklook && !fullStarted ? 'Quick look done' : 'Analyze this clip'}
          </button>
          {(file || tryId) && !running && (
            <button
              type="button"
              onClick={discardAndReset}
              className="min-h-[44px] rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
            >
              Start over
            </button>
          )}
        </div>
      </section>

      {(tryId || running || finished) && (
        <section aria-label="Progress" className="rounded-lg border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">Progress</h2>
          {scanning && stills[1] && (
            <div className="scan-wrap mb-2 max-w-[220px] rounded">
              {scanImg(stills[1].jpeg)}
              <div aria-hidden="true" className="anim-scan" />
            </div>
          )}
          <ol className="flex flex-col gap-1">
            {(Object.keys(STEP_LABELS) as StepKey[]).map((k) => (
              <li key={k} className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  key={steps[k]}
                  className={steps[k] === 'done' || steps[k] === 'error' ? 'anim-pop' : undefined}
                >
                  {steps[k] === 'done' ? '✓' : steps[k] === 'busy' ? '…' : steps[k] === 'error' ? '✕' : '○'}
                </span>
                <span className={steps[k] === 'error' ? 'font-semibold text-red-700' : 'text-stone-700'}>
                  {STEP_LABELS[k]}
                  {steps[k] === 'done' && timings[k] !== undefined && (
                    <span className="text-stone-500"> · {(timings[k] as number / 1000).toFixed(1)} s</span>
                  )}
                </span>
                {steps[k] === 'error' && k !== 'upload' && k !== 'start' && (
                  <button
                    type="button"
                    onClick={() => retryStep(k)}
                    className="ml-auto min-h-[44px] rounded border border-stone-300 px-3 py-1 text-xs font-semibold text-stone-700 hover:bg-stone-100"
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ol>
          {totalMs > 0 && (
            <p className="mt-2 text-sm font-semibold text-stone-800">
              Total step time {(totalMs / 1000).toFixed(1)} s
            </p>
          )}
        </section>
      )}

      {headlineKind && (
        <section aria-label="Result" className="rounded-lg border border-stone-200 bg-white p-4">
          {headlineKind === 'clear' && (
            <>
              <p className="anim-rise text-lg font-bold text-stone-900">
                Road looks normal, nothing posted
              </p>
              <button
                type="button"
                onClick={runFullAnyway}
                disabled={running}
                className="mt-3 min-h-[44px] w-full rounded-md border border-blue-700 px-4 py-2 text-sm font-semibold text-blue-700 disabled:opacity-40 sm:w-auto"
              >
                {running ? 'Analyzing…' : 'Run full analysis anyway'}
              </button>
              <p className="mt-1 text-xs text-stone-500">Uses the same try and budget.</p>
              {!postDone && (
                <button
                  type="button"
                  onClick={() => setPostOpen('clear')}
                  disabled={running}
                  className="mt-2 min-h-[44px] w-full rounded-md border border-emerald-700 px-4 py-2 text-sm font-semibold text-emerald-700 disabled:opacity-40 sm:w-auto"
                >
                  Post all-clear to the live map
                </button>
              )}
            </>
          )}
          {headlineKind === 'notroad' && (
            <p className="anim-rise text-lg font-bold text-stone-900">
              This doesn&apos;t look like road footage.
            </p>
          )}
          {headlineKind === 'normal' && (
            <p className="anim-rise text-lg font-bold text-stone-900">
              Road looks normal, nothing posted
            </p>
          )}
          {headlineKind === 'incident' && (
            <>
              <p className="anim-rise text-lg font-bold text-stone-900">{incidentHeadline}</p>
              {stored && cleared && (
                <p className="mt-1 text-sm font-semibold text-stone-800">
                  clears in about {cleared.likelyMin} min
                </p>
              )}
              {stored && finished && cost !== null && !postDone && (
                <button
                  type="button"
                  onClick={() => setPostOpen('incident')}
                  className="mt-3 min-h-[44px] w-full rounded-md bg-[#F2B544] px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-[#F6C453] sm:w-auto"
                >
                  Post to the live map
                </button>
              )}
              {finished && cost !== null && (
                <button
                  type="button"
                  onClick={addToSim}
                  className="mt-2 min-h-[44px] w-full rounded-md bg-[#F2B544] px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-[#F6C453] sm:w-auto"
                >
                  Add to the I-95 simulation
                </button>
              )}
            </>
          )}
          {postDone && (headlineKind === 'clear' || headlineKind === 'incident') && (
            <p role="status" className="mt-2 text-sm font-semibold text-emerald-800">
              {postDone}
            </p>
          )}
        </section>
      )}

      {hasDetails && (
        <section aria-label="Details" className="flex flex-col gap-6">
          <button
            type="button"
            onClick={() => setDetailsOpen(!detailsOpen)}
            aria-expanded={detailsOpen}
            className="min-h-[44px] rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
          >
            {detailsOpen ? 'Hide details ▾' : 'Show details ▸'}
          </button>
          {detailsOpen && (
            <div className="anim-fade flex flex-col gap-6">
      {detect && (
        <section aria-label="Stills" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            Stills with objects found
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {detect.map((s) => {
              const still = stills.find((x) => x.index === s.index);
              const sensitive = [...(s.boxes.face ?? []), ...(s.boxes['license plate'] ?? [])];
              const entries = Object.entries(s.boxes)
                .filter(([concept]) => !SENSITIVE_CONCEPTS.has(concept))
                .flatMap(([concept, boxes]) =>
                  boxes.map((b) => ({ ...b, concept })),
                );
              return (
                <figure key={s.index} className="rounded-lg border border-stone-200 bg-white p-2">
                  <div className="relative w-full">
                    {still && (
                      <BlurredStill
                        jpeg={still.jpeg}
                        boxes={sensitive}
                        alt={`Still ${s.index + 1} at ${s.seconds.toFixed(1)} s, faces and plates blurred`}
                      />
                    )}
                    <svg
                      viewBox={`0 0 ${s.width} ${s.height}`}
                      className="pointer-events-none absolute inset-0 h-full w-full"
                      aria-hidden="true"
                    >
                      {entries.map((b) => (
                        <rect
                          key={b.id}
                          x={b.x1}
                          y={b.y1}
                          width={Math.max(1, b.x2 - b.x1)}
                          height={Math.max(1, b.y2 - b.y1)}
                          fill="none"
                          stroke={BOX_COLORS[b.concept] ?? '#fbbf24'}
                          strokeWidth={Math.max(2, s.width / 400)}
                        />
                      ))}
                    </svg>
                  </div>
                  <figcaption className="mt-1 text-xs text-stone-600">
                    Still {s.index + 1} · {s.seconds.toFixed(1)} s ·{' '}
                    {Object.entries(s.counts)
                      .filter(([c, n]) => n > 0 && !SENSITIVE_CONCEPTS.has(c))
                      .map(([c, n]) => `${n} ${c}`)
                      .join(', ') || 'nothing found'}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      )}

      {verdict && (
        <section aria-label="Scene verdict" className="rounded-lg border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">Scene verdict</h2>
          {!roadScene ? (
            <p className="text-lg font-bold text-stone-900">This doesn&apos;t look like road footage.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-stone-800">{verdict.summary}</p>
              <p className="text-sm text-stone-600">
                {verdict.incident ? `${typePhrase(verdict.type)} · ` : 'No incident · '}
                Severity: {verdict.severity}
                {(() => {
                  const s = stagePhrase(verdict.stage);
                  return s ? ` · ${s}` : '';
                })()}
              </p>
              <p className="text-sm text-stone-600">
                Responders:{' '}
                {[
                  ['Police', verdict.responders.police],
                  ['Ambulance', verdict.responders.ambulance],
                  ['Fire', verdict.responders.fire],
                  ['Tow', verdict.responders.towTruck],
                ]
                  .map(([label, on]) => `${label} ${on ? '✓' : '—'}`)
                  .join(' · ')}
              </p>
              {checks.length > 0 && (
                <ul className="flex flex-col gap-1 border-t border-stone-100 pt-2">
                  {checks.map((c) => (
                    <li key={c.claim} className="text-xs text-stone-600">
                      <span
                        className={
                          c.status === 'supported'
                            ? 'font-semibold text-green-700'
                            : c.status === 'conflict'
                              ? 'font-semibold text-red-700'
                              : 'font-semibold text-amber-700'
                        }
                      >
                        {c.status}
                      </span>{' '}
                      {c.claim}
                      {c.detail ? ` — ${c.detail}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {stored && cleared && (
        <section aria-label="Incident assessment" className="rounded-lg border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">
            Incident assessment · {stored.source === 'muse-wonder' ? 'Muse Wonder' : 'fallback table'}
          </h2>
          <p className="text-lg font-bold text-stone-900">
            Clears in about {cleared.likelyMin} min
          </p>
          <p className="text-sm text-stone-600">
            Range {cleared.lowMin}–{cleared.highMin} min ·{' '}
            {confidencePhrase(stored.assessment.confidence)}
          </p>
          <p className="mt-1 text-sm text-stone-700">{stored.assessment.rangeReason}</p>
          <p className="text-sm text-stone-600">Narrows if: {stored.assessment.narrowsIf}</p>
          <p className="mt-1 text-sm text-stone-700">{stored.assessment.driverMessage}</p>
        </section>
      )}

      {cost !== null && (finished || (quicklook && quicklook.flag === 'clear' && !fullStarted)) && (
        <section aria-label="Cost" className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm font-semibold text-stone-800">
            This analysis cost {fmtCost(cost)}.{finished ? ' The clip has been deleted.' : ''}
          </p>
          {timings.quicklook !== undefined && (
            <p className="mt-1 text-sm text-stone-600">
              Quick look {(timings.quicklook / 1000).toFixed(1)} s
              {totalMs > 0 && ` · total step time ${(totalMs / 1000).toFixed(1)} s`}
            </p>
          )}
        </section>
      )}
            </div>
          )}
        </section>
      )}

      {postOpen && tryId && (
        <PostMapModal
          tryId={tryId}
          kind={postOpen}
          stills={stills}
          detect={detect}
          onClose={() => setPostOpen(null)}
          onPosted={(road) => {
            setPostOpen(null);
            setPostDone(
              postOpen === 'incident'
                ? `Posted${road ? ` on ${road}` : ''}. Drivers whose route passes this spot in the next 2 hours will be warned.`
                : 'All-clear posted. If another camera agrees, the incident clears.',
            );
          }}
        />
      )}
    </main>
  );
}
