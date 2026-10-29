'use client';

import { useRef, useState } from 'react';

import { upload } from '@vercel/blob/client';

import { displayClearance, type AgentAssessment } from '@/lib/agent-guard';
import type { VerdictCheck } from '@/lib/checks';
import type { Verdict } from '@/lib/verdict';

const MAX_SECONDS = 30;
const MAX_BYTES = 50 * 1024 * 1024;
const STEP_TIMEOUT_MS = 55000;
const STILL_FRACS = [0.2, 0.45, 0.7, 0.9];

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

type StepKey = 'upload' | 'start' | 'detect' | 'verdict' | 'assess' | 'finish';
type StepStatus = 'idle' | 'busy' | 'done' | 'error';

const STEP_LABELS: Record<StepKey, string> = {
  upload: 'Uploading clip',
  start: 'Reserving a try',
  detect: 'Finding objects on 4 stills',
  verdict: 'Reading the scene',
  assess: 'Tracking the incident',
  finish: 'Deleting the clip',
};

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
  detect: 'idle',
  verdict: 'idle',
  assess: 'idle',
  finish: 'idle',
};

export default function TryPage() {
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
  const inputRef = useRef<HTMLInputElement>(null);

  const setStep = (k: StepKey, v: StepStatus) => setSteps((s) => ({ ...s, [k]: v }));

  async function run<T>(key: StepKey, fn: () => Promise<T>): Promise<T> {
    setStep(key, 'busy');
    try {
      const out = await fn();
      setStep(key, 'done');
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

  async function startFlow() {
    if (!file || duration === null || stills.length !== 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = await run('upload', async () => {
        const res = await upload(`tries/${file.name}`, file, {
          access: 'public',
          handleUploadUrl: '/api/try/upload-token',
        });
        setBlobUrl(res.url);
        return res.url;
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
      const det = await run('detect', async () => {
        const data = await postJson<{ stills: DetectStill[] }>('/api/try/detect', {
          tryId: id,
          stills: stills.map(stillPayload),
        });
        setDetect(data.stills);
        return data.stills;
      });
      const ver = await run('verdict', async () => {
        const data = await postJson<{ verdict: Verdict; checks: VerdictCheck[]; roadScene: boolean }>(
          '/api/try/verdict',
          { tryId: id, samSummary: samSummaryFor(det) },
        );
        setVerdict(data.verdict);
        setChecks(data.checks);
        setRoadScene(data.roadScene);
        return data;
      });
      if (ver.roadScene) {
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
      if (key === 'detect') {
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

  function addToSim() {
    if (!verdict || !stored || !blobUrl || duration === null || cost === null) return;
    try {
      sessionStorage.setItem(
        'try-incident',
        JSON.stringify({
          verdict,
          checks,
          stored,
          cost,
          clipSeconds: Math.round(duration),
          stills: stills.map((s) => ({ seconds: s.seconds, jpeg: s.jpeg })),
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
  const canRun = file && duration !== null && stills.length === 4 && !running && !finished;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-stone-900">Try your own clip</h1>
        <p className="text-sm text-stone-600">
          Upload a short road clip (mp4 or mov, max 30 s, max 50 MB). We find the objects,
          read the scene and track the incident — then delete the clip.
        </p>
      </header>

      <section className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
        <label
          htmlFor="clip"
          className="flex min-h-[44px] cursor-pointer items-center justify-center rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
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
            className="min-h-[44px] flex-1 rounded-md bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? 'Analyzing…' : finished ? 'Analyzed' : 'Analyze this clip'}
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
          <ol className="flex flex-col gap-1">
            {(Object.keys(STEP_LABELS) as StepKey[]).map((k) => (
              <li key={k} className="flex items-center gap-2 text-sm">
                <span aria-hidden="true">
                  {steps[k] === 'done' ? '✓' : steps[k] === 'busy' ? '…' : steps[k] === 'error' ? '✕' : '○'}
                </span>
                <span className={steps[k] === 'error' ? 'font-semibold text-red-700' : 'text-stone-700'}>
                  {STEP_LABELS[k]}
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
        </section>
      )}

      {detect && (
        <section aria-label="Stills" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            Stills with objects found
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {detect.map((s) => {
              const still = stills.find((x) => x.index === s.index);
              const entries = Object.entries(s.boxes).flatMap(([concept, boxes]) =>
                boxes.map((b) => ({ ...b, concept })),
              );
              return (
                <figure key={s.index} className="rounded-lg border border-stone-200 bg-white p-2">
                  <div className="relative w-full">
                    {still && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={still.jpeg} alt={`Still ${s.index + 1} at ${s.seconds.toFixed(1)} s`} className="h-auto w-full rounded" />
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
                      .filter(([, n]) => n > 0)
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
                {verdict.incident ? `Type: ${verdict.type} · ` : 'No incident · '}
                Severity: {verdict.severity} · Stage: {verdict.stage}
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
            Range {cleared.lowMin}–{cleared.highMin} min · {stored.assessment.confidence} confidence
          </p>
          <p className="mt-1 text-sm text-stone-700">{stored.assessment.rangeReason}</p>
          <p className="text-sm text-stone-600">Narrows if: {stored.assessment.narrowsIf}</p>
          <p className="mt-1 text-sm text-stone-700">{stored.assessment.driverMessage}</p>
        </section>
      )}

      {finished && cost !== null && (
        <section aria-label="Cost" className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm font-semibold text-stone-800">
            This analysis cost ${cost.toFixed(2)}. The clip has been deleted.
          </p>
          {roadScene && verdict?.incident && (
            <button
              type="button"
              onClick={addToSim}
              className="mt-3 min-h-[44px] w-full rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 sm:w-auto"
            >
              Add to the I-95 simulation
            </button>
          )}
        </section>
      )}
    </main>
  );
}
