'use client';

import { useEffect, useRef, useState } from 'react';

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
  const [selected, setSelected] = useState('');
  const [lastRunCost, setLastRunCost] = useState<number | null>(null);

  const [estimating, setEstimating] = useState(false);
  const [pending, setPending] = useState<{ uncached: string[]; estimate: number } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setPending(null);
    setLastRunCost(null);
    setError(null);
  };

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
      const withObjects = data.summaries.find((s) => s.objects > 0);
      setSelected(withObjects?.concept ?? data.summaries[0]?.concept ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analyze failed');
    } finally {
      setAnalyzing(false);
    }
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

          {summaries && (
            <section>
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
                        <td className="px-2 py-1.5">{s.objects}</td>
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
            </section>
          )}

          <section>
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
        </div>
      )}
    </main>
  );
}
