'use client';

import { useEffect, useRef, useState } from 'react';

import { formatCount } from '@/lib/format';

interface PreppedClip {
  name: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  sizeBytes: number;
}

interface SamBox {
  frame: number;
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c: number | null;
}

interface SamSummary {
  concept: string;
  objects: number;
  firstFrame: number | null;
  lastFrame: number | null;
  maxConfidence: number | null;
  cached?: boolean;
}

interface SamResult {
  summary: SamSummary;
  boxes: SamBox[];
  width: number;
  height: number;
  fps: number;
}

interface Verdict {
  incident: boolean;
  type: string;
  severity: string | null;
  vehiclesInvolved: number | null;
  lanesBlocked: string;
  responders: { police: boolean; ambulance: boolean; fire: boolean; towTruck: boolean };
  stage: string;
  hazards: string[];
  evidence: { second: number; what: string }[];
  confidence: number;
  summary: string;
  details: string;
  peopleOnRoad: number | null;
  workersOrRespondersVisible: boolean;
}

interface VerdictCheck {
  claim: string;
  status: 'supported' | 'unverified' | 'conflict';
  detail: string;
}

const RESPONDER_BADGES = [
  { key: 'police', label: 'Police' },
  { key: 'ambulance', label: 'Ambulance' },
  { key: 'fire', label: 'Fire crew' },
  { key: 'towTruck', label: 'Tow truck' },
] as const;

const PRICE_PER_1K_FRAMES = 0.2;
const MIN_BILLABLE_FRAMES = 50;

function estimateFor(frameCount: number, uncachedConcepts: number): number {
  return (
    (Math.max(MIN_BILLABLE_FRAMES, frameCount) / 1000) *
    PRICE_PER_1K_FRAMES *
    uncachedConcepts
  );
}

function fmtUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtPrecise(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return fmtUSD(n);
}

function pretty(value: string): string {
  return value.replace(/_/g, ' ');
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

export default function LabPage() {
  const [clips, setClips] = useState<PreppedClip[]>([]);
  const [concepts, setConcepts] = useState<string[]>([]);
  const [spent, setSpent] = useState(0);
  const [budget, setBudget] = useState(150);
  const [loading, setLoading] = useState(true);

  const [clip, setClip] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [summaries, setSummaries] = useState<SamSummary[] | null>(null);
  const [results, setResults] = useState<Record<string, SamResult>>({});
  const [trueCounts, setTrueCounts] = useState<Record<string, number | null>>({});
  const [selected, setSelected] = useState('');
  const [lastRunCost, setLastRunCost] = useState<number | null>(null);

  const [estimating, setEstimating] = useState(false);
  const [pending, setPending] = useState<{ uncached: string[]; estimate: number } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checks, setChecks] = useState<VerdictCheck[]>([]);
  const [verdictCached, setVerdictCached] = useState(false);
  const [verdictCost, setVerdictCost] = useState<number | null>(null);
  const [verdictStatus, setVerdictStatus] = useState<{
    cached: boolean;
    estimateUSD: number;
    hasSamResults: boolean;
  } | null>(null);
  const [verdictLoading, setVerdictLoading] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeClip = clips.find((c) => c.name === clip) ?? null;
  const selectedResult = selected && results[selected] ? results[selected] : null;

  // Mutable overlay snapshot for the draw loop (avoids restarting rAF).
  const overlayRef = useRef<{
    boxes: SamBox[];
    width: number;
    height: number;
    fps: number;
    concept: string;
  } | null>(null);
  overlayRef.current = selectedResult
    ? {
        boxes: selectedResult.boxes,
        width: selectedResult.width,
        height: selectedResult.height,
        fps: selectedResult.fps,
        concept: selected,
      }
    : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/lab/clips');
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as {
          clips: PreppedClip[];
          spentTotal: number;
          concepts: string[];
          budgetUSD: number;
        };
        if (cancelled) return;
        setClips(data.clips);
        setSpent(data.spentTotal);
        setConcepts(data.concepts);
        setBudget(data.budgetUSD);
        setChecked(data.concepts);
        if (data.clips.length > 0) setClip(data.clips[0].name);
        if (data.concepts.length > 0) setSelected(data.concepts[0]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load clips');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Box overlay: redrawn every animation frame so boxes track the video while
  // it plays and stay aligned when paused or seeked.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      const w = video.clientWidth;
      const h = video.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const ov = overlayRef.current;
      if (!ov || ov.width <= 0 || ov.height <= 0 || ov.fps <= 0) return;
      const frame = Math.floor(video.currentTime * ov.fps);
      const sx = w / ov.width;
      const sy = h / ov.height;
      ctx.font = '12px system-ui, sans-serif';
      ctx.lineWidth = 2;
      for (const b of ov.boxes) {
        if (b.frame !== frame) continue;
        const x = b.x1 * sx;
        const y = b.y1 * sy;
        const bw = (b.x2 - b.x1) * sx;
        const bh = (b.y2 - b.y1) * sy;
        ctx.strokeStyle = '#fbbf24';
        ctx.strokeRect(x, y, bw, bh);
        const label = `${ov.concept} #${b.id}${b.c === null ? '' : ` ${b.c.toFixed(2)}`}`;
        const tw = ctx.measureText(label).width;
        const ly = y - 18 >= 0 ? y - 18 : y;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(x, ly, tw + 8, 18);
        ctx.fillStyle = '#fde68a';
        ctx.fillText(label, x + 4, ly + 13);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toggleConcept = (concept: string) => {
    setPending(null);
    setChecked((prev) =>
      prev.includes(concept) ? prev.filter((c) => c !== concept) : [...prev, concept],
    );
  };

  const onClipChange = (name: string) => {
    setClip(name);
    setSummaries(null);
    setResults({});
    setTrueCounts({});
    setPending(null);
    setLastRunCost(null);
    setError(null);
    setVerdict(null);
    setChecks([]);
    setVerdictCached(false);
    setVerdictCost(null);
    setVerdictStatus(null);
  };

  // Probe the verdict cache whenever the clip changes so the button can show
  // the estimate (or "cached, $0") before anything is spent.
  useEffect(() => {
    if (!clip) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/lab/verdict?clip=${encodeURIComponent(clip)}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          cached: boolean;
          estimateUSD: number;
          hasSamResults: boolean;
        };
        if (!cancelled) setVerdictStatus(data);
      } catch {
        // Leave the button without an estimate; the POST will surface errors.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clip]);

  const onAnalyzeClick = async () => {
    if (!clip || checked.length === 0 || estimating || analyzing) return;
    setError(null);
    setEstimating(true);
    try {
      // Probe the cache per concept so the estimate covers uncached ones only.
      const probes = await Promise.all(
        checked.map(async (concept) => {
          const res = await fetch(
            `/api/lab/result?clip=${encodeURIComponent(clip)}&concept=${encodeURIComponent(concept)}`,
          );
          return { concept, cached: res.ok };
        }),
      );
      const uncached = probes.filter((p) => !p.cached).map((p) => p.concept);
      const frames = activeClip?.frameCount ?? MIN_BILLABLE_FRAMES;
      setPending({ uncached, estimate: estimateFor(frames, uncached.length) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cache check failed');
    } finally {
      setEstimating(false);
    }
  };

  const onConfirm = async () => {
    if (!clip || checked.length === 0 || analyzing) return;
    setError(null);
    setAnalyzing(true);
    setPending(null);
    try {
      const res = await fetch('/api/lab/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clip, concepts: checked }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as {
        summaries: SamSummary[];
        estCostThisRun: number;
        spentTotal: number;
      };
      setSummaries(data.summaries);
      setLastRunCost(data.estCostThisRun);
      setSpent(data.spentTotal);

      const fetched: Record<string, SamResult> = {};
      for (const s of data.summaries) {
        const r = await fetch(
          `/api/lab/result?clip=${encodeURIComponent(clip)}&concept=${encodeURIComponent(s.concept)}`,
        );
        if (!r.ok) throw new Error(await readError(r));
        fetched[s.concept] = (await r.json()) as SamResult;
      }
      setResults(fetched);
      const stills: Record<string, number | null> = {};
      for (const concept of ['car', 'truck', 'person']) {
        if (!data.summaries.some((s) => s.concept === concept)) continue;
        try {
          const r = await fetch(
            `/api/lab/stills?clip=${encodeURIComponent(clip)}&concept=${encodeURIComponent(concept)}`,
          );
          if (r.ok) stills[concept] = ((await r.json()) as { count: number | null }).count;
        } catch {
          // Leave unset; the video count still shows.
        }
      }
      setTrueCounts(stills);
      const withObjects = data.summaries.find((s) => s.objects > 0);
      setSelected(withObjects?.concept ?? data.summaries[0]?.concept ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analyze failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const onVerdictClick = async () => {
    if (!clip || verdictLoading) return;
    setError(null);
    setVerdictLoading(true);
    try {
      const res = await fetch('/api/lab/verdict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clip }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as {
        verdict: Verdict;
        checks: VerdictCheck[];
        cached: boolean;
        estCostThisRun: number;
        spentTotal: number;
      };
      setVerdict(data.verdict);
      setChecks(data.checks);
      setVerdictCached(data.cached);
      setVerdictCost(data.estCostThisRun);
      setSpent(data.spentTotal);
      setVerdictStatus((prev) => ({
        cached: true,
        estimateUSD: 0,
        hasSamResults: prev?.hasSamResults ?? summaries !== null,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verdict failed');
    } finally {
      setVerdictLoading(false);
    }
  };

  const onEvidenceClick = (second: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = second;
    video.pause();
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl bg-white px-4 py-6 text-stone-900">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Perception Lab</h1>
        <p className="text-sm text-stone-600 tabular-nums">
          Spent so far: <span className="font-semibold text-stone-900">{fmtUSD(spent)}</span> of{' '}
          {fmtUSD(budget)}
        </p>
      </header>
      <p className="mt-1 text-sm text-stone-600">
        Pick a prepped clip, run SAM 3.1 tracking per concept, and watch the boxes on the video.
      </p>

      {loading ? (
        <p className="mt-6 text-sm text-stone-600">Loading clips…</p>
      ) : clips.length === 0 ? (
        <div className="mt-6 rounded-md border border-stone-200 bg-stone-50 p-4 text-sm text-stone-700">
          No prepped clips yet. Drop a raw clip into <code>clips/raw/</code> and run{' '}
          <code className="rounded bg-stone-200 px-1">npx tsx scripts/prep-clip.ts all</code>, then
          reload this page.
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <section className="space-y-4 rounded-lg border border-stone-200 p-4">
            <div>
              <label htmlFor="clip" className="mb-1 block text-sm font-medium">
                Clip
              </label>
              <select
                id="clip"
                value={clip}
                onChange={(e) => onClipChange(e.target.value)}
                className="w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-sm sm:max-w-md"
              >
                {clips.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} — {c.frameCount} frames, {c.fps} fps, {c.width}×{c.height}
                  </option>
                ))}
              </select>
            </div>

            <fieldset>
              <legend className="mb-1 text-sm font-medium">Concepts</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {concepts.map((concept) => (
                  <label
                    key={concept}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-stone-200 px-2 py-1.5 text-sm hover:bg-stone-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked.includes(concept)}
                      onChange={() => toggleConcept(concept)}
                      className="h-4 w-4 accent-teal-700"
                    />
                    {concept}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onAnalyzeClick}
                disabled={checked.length === 0 || estimating || analyzing}
                className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {estimating ? 'Checking cache…' : analyzing ? 'Analyzing…' : 'Analyze'}
              </button>
              {lastRunCost !== null && (
                <p className="text-sm text-stone-600 tabular-nums">
                  Last run: {fmtUSD(lastRunCost)}
                </p>
              )}
            </div>

            {pending && !analyzing && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                {pending.uncached.length === 0 ? (
                  <p>
                    All {checked.length} concept{checked.length === 1 ? ' is' : 's are'} cached —
                    this run is free ({fmtUSD(0)}).
                  </p>
                ) : (
                  <p className="tabular-nums">
                    {pending.uncached.length} of {checked.length} concepts need fresh SAM calls
                    (≈{activeClip?.frameCount ?? MIN_BILLABLE_FRAMES} frames each ×{' '}
                    {fmtUSD(PRICE_PER_1K_FRAMES)}/1k frames). Estimated cost:{' '}
                    <span className="font-semibold">{fmtUSD(pending.estimate)}</span>
                  </p>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={onConfirm}
                    className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800"
                  >
                    Confirm &amp; analyze
                  </button>
                  <button
                    type="button"
                    onClick={() => setPending(null)}
                    className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>

          {error && (
            <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
          {summaries && (
            <section className="order-1 min-w-0">
              <h2 className="mb-2 text-lg font-semibold">Results</h2>
              <table className="w-full border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-stone-300 text-left text-stone-600">
                    <th className="px-2 py-1.5 font-medium">Concept</th>
                    <th className="px-2 py-1.5 font-medium">Objects</th>
                    <th className="px-2 py-1.5 font-medium">Frames</th>
                    <th className="px-2 py-1.5 font-medium">Max conf</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s) => {
                    const empty = s.objects === 0;
                    const isSelected = s.concept === selected;
                    const trueCount = trueCounts[s.concept] ?? null;
                    return (
                      <tr
                        key={s.concept}
                        onClick={() => setSelected(s.concept)}
                        aria-selected={isSelected}
                        className={`cursor-pointer border-b border-stone-100 tabular-nums hover:bg-stone-50 ${
                          empty ? 'text-stone-400' : ''
                        } ${isSelected ? 'bg-teal-50 hover:bg-teal-50' : ''}`}
                      >
                        <td className="px-2 py-1.5">
                          {s.concept}
                          {s.cached ? (
                            <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-[11px] text-stone-600">
                              cached
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5">
                          {formatCount(s.objects)}
                          {trueCount !== null && (
                            <span className="block text-[11px] text-stone-500">
                              true count (stills): {trueCount}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {s.firstFrame === null || s.lastFrame === null
                            ? '—'
                            : `${s.firstFrame}–${s.lastFrame}`}
                        </td>
                        <td className="px-2 py-1.5">
                          {s.maxConfidence === null ? '—' : s.maxConfidence.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-xs text-stone-500">
                Click a row to overlay that concept on the video.
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Counts of 16+ hit the video tracking cap (max 16 objects per frame).
              </p>
            </section>
          )}

          <section className="order-2 min-w-0 lg:order-3 lg:col-span-2">
            <h2 className="mb-2 text-lg font-semibold">
              Video
              {selectedResult ? (
                <span className="ml-2 text-sm font-normal text-stone-600">
                  overlay: {selected}
                </span>
              ) : null}
            </h2>
            <div className="relative w-full max-w-3xl overflow-hidden rounded-md border border-stone-300 bg-black">
              <video
                key={clip}
                ref={videoRef}
                src={`/clips/prepped/${encodeURIComponent(clip)}.mp4`}
                controls
                playsInline
                className="block h-auto w-full"
              />
              <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
            </div>
          </section>

          <section className={`order-3 min-w-0 ${summaries ? 'lg:order-2' : 'lg:col-span-2'}`}>
            <h2 className="mb-2 text-lg font-semibold">
              Scene verdict
              {verdictCached && (
                <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 align-middle text-[11px] font-normal text-stone-600">
                  cached
                </span>
              )}
            </h2>
            <div className="space-y-3 rounded-lg border border-stone-200 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onVerdictClick}
                  disabled={!clip || verdictLoading}
                  className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {verdictLoading ? 'Reading scene…' : 'Get verdict'}
                </button>
                <p className="text-sm text-stone-600 tabular-nums">
                  {verdictStatus === null
                    ? 'estimating…'
                    : verdictStatus.cached
                      ? 'cached, $0'
                      : `≈${fmtPrecise(verdictStatus.estimateUSD)}`}
                </p>
                {verdictCost !== null && (
                  <p className="text-sm text-stone-600 tabular-nums">
                    Last verdict: {fmtPrecise(verdictCost)}
                  </p>
                )}
              </div>
              {!summaries &&
                verdictStatus !== null &&
                !verdictStatus.hasSamResults && (
                  <p className="text-xs text-stone-500">
                    Tip: run Analyze first so the verdict can be cross-checked against tracked
                    objects.
                  </p>
                )}
              {verdict && (
                <div className="space-y-3">
                  <p className="text-lg font-medium leading-snug">{verdict.summary}</p>
                  <p className="text-sm text-stone-600">{verdict.details}</p>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {[
                      `type: ${pretty(verdict.type)}`,
                      `severity: ${verdict.severity === null ? '—' : pretty(verdict.severity)}`,
                      `stage: ${pretty(verdict.stage)}`,
                      `lanes: ${pretty(verdict.lanesBlocked)}`,
                      `vehicles: ${verdict.vehiclesInvolved === null ? '—' : verdict.vehiclesInvolved}`,
                    ].map((chip) => (
                      <span
                        key={chip}
                        className="rounded-full bg-stone-100 px-2.5 py-1 text-stone-700"
                      >
                        {chip}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {RESPONDER_BADGES.map(({ key, label }) => {
                      const check = checks.find((c) => c.claim === `${label} on scene`);
                      const claimed = verdict.responders[key];
                      const ok = check?.status === 'supported';
                      return (
                        <span
                          key={key}
                          title={check?.detail ?? 'No cross-check yet.'}
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 ${
                            claimed
                              ? ok
                                ? 'border-teal-700 bg-teal-50 text-teal-900'
                                : 'border-amber-500 bg-amber-50 text-amber-900'
                              : 'border-stone-200 bg-stone-50 text-stone-500'
                          }`}
                        >
                          <span aria-hidden="true">
                            {!check || ok ? '✓' : check.status === 'conflict' ? '✕' : '⚠'}
                          </span>
                          {label}
                          {!claimed && <span className="opacity-75">· none</span>}
                        </span>
                      );
                    })}
                  </div>
                  {checks.filter(
                    (c) => !RESPONDER_BADGES.some((b) => c.claim === `${b.label} on scene`),
                  ).length > 0 && (
                    <ul className="space-y-1 text-xs text-stone-700">
                      {checks
                        .filter(
                          (c) => !RESPONDER_BADGES.some((b) => c.claim === `${b.label} on scene`),
                        )
                        .map((c) => (
                          <li key={c.claim} className="flex gap-2">
                            <span
                              aria-hidden="true"
                              className={
                                c.status === 'supported'
                                  ? 'text-teal-700'
                                  : c.status === 'conflict'
                                    ? 'text-red-700'
                                    : 'text-amber-600'
                              }
                            >
                              {c.status === 'supported' ? '✓' : c.status === 'conflict' ? '✕' : '⚠'}
                            </span>
                            <span>
                              <span className="font-medium">{c.claim}:</span> {c.detail}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                  {verdict.hazards.length > 0 && (
                    <p className="text-xs text-stone-700">
                      <span className="font-medium">Hazards:</span> {verdict.hazards.join('; ')}
                    </p>
                  )}
                  {verdict.evidence.length > 0 && (
                    <div>
                      <h3 className="mb-1 text-sm font-medium">Evidence</h3>
                      <ul className="space-y-2">
                        {verdict.evidence.map((e) => (
                          <li key={`${e.second}-${e.what}`}>
                            <button
                              type="button"
                              onClick={() => onEvidenceClick(e.second)}
                              className="block w-full rounded-md border border-stone-200 px-3 py-2 text-left text-sm hover:bg-stone-50"
                            >
                              <span className="font-semibold tabular-nums">
                                {e.second.toFixed(0)}s
                              </span>
                              <span className="text-stone-600"> — {e.what}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 text-xs text-stone-500">
                        Click an item to seek the video to that moment.
                      </p>
                    </div>
                  )}
                  <p className="text-xs tabular-nums text-stone-500">
                    Model confidence: {verdict.confidence.toFixed(2)}
                  </p>
                </div>
              )}
            </div>
          </section>
          </div>
        </div>
      )}
    </main>
  );
}
