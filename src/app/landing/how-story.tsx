'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

/** Anchor link with smooth scroll + a visible pulse on the section. */
export function HowLink() {
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document
      .querySelector('#how')
      ?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    window.history.pushState(null, '', '#how');
    window.dispatchEvent(new CustomEvent('how-pulse'));
  };
  return (
    <a
      href="#how"
      onClick={onClick}
      className="font-semibold text-[#7CB4FF] hover:text-white hover:underline"
    >
      How it works
    </a>
  );
}

const TRACK_STAGES = [
  { likely: 72, lo: 55, hi: 95, stage: 'no help on scene yet', report: 'Report 1' },
  { likely: 36, lo: 27, hi: 46, stage: 'responders on scene', report: 'Report 2' },
  { likely: 10, lo: 6, hi: 15, stage: 'tow truck working', report: 'Report 3' },
];

/** 72 → 36 → 10 clearance counter with a shrinking range bar. */
function TrackCounter() {
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const [shown, setShown] = useState(72);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Reduced motion (or no observer): final values, no tween.
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setIdx(TRACK_STAGES.length - 1);
      setShown(10);
      return;
    }
    let raf = 0;
    let stopped = false;
    const timers: number[] = [];
    const tween = (from: number, to: number) => {
      const t0 = performance.now();
      const step = (now: number) => {
        if (stopped) return;
        const p = Math.min(1, (now - t0) / 700);
        setShown(Math.round(from + (to - from) * (1 - (1 - p) * (1 - p))));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.disconnect();
          let prev = 72;
          TRACK_STAGES.forEach((s, i) => {
            if (i === 0) return;
            timers.push(
              window.setTimeout(() => {
                setIdx(i);
                tween(prev, s.likely);
                prev = s.likely;
              }, i * 1400),
            );
          });
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      stopped = true;
      io.disconnect();
      for (const t of timers) clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, []);

  const cur = TRACK_STAGES[idx];
  return (
    <div ref={ref} className="rd-card rise p-4" style={{ transitionDelay: '150ms' }}>
      <p className="font-landing-mono text-xs uppercase tracking-widest text-slate-300">
        {cur.report} · {cur.stage}
      </p>
      <p className="font-landing-mono mt-1 text-5xl font-semibold text-white tabular-nums">
        {shown}
        <span className="text-lg text-slate-300"> min</span>
      </p>
      <div aria-hidden="true" className="mt-3 h-2.5 w-full rounded-full bg-slate-700">
        <div
          className="track-bar relative h-2.5 rounded-full bg-amber-400"
          style={{ left: `${cur.lo}%`, width: `${Math.max(2, cur.hi - cur.lo)}%` }}
        />
      </div>
      <p className="font-landing-mono mt-1 text-xs text-slate-300 tabular-nums">
        between {cur.lo} and {cur.hi} min
      </p>
    </div>
  );
}

/** How-it-works scroll story: real blurred frames, real numbers. */
export function HowSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const [flash, setFlash] = useState(false);
  const timers = useRef<number[]>([]);

  // Reveal each step once when scrolled into view (fallback shows all).
  useEffect(() => {
    const root = sectionRef.current;
    if (!root) return;
    const steps = Array.from(root.querySelectorAll<HTMLElement>('.how-step'));
    if (steps.length === 0) return;
    const showAll = () => {
      for (const s of steps) s.classList.add('on');
    };
    if (
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
      typeof IntersectionObserver === 'undefined'
    ) {
      showAll();
      return;
    }
    const fallback = setTimeout(showAll, 1500);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) (e.target as HTMLElement).classList.add('on');
        }
        if ([...steps].every((s) => s.classList.contains('on'))) {
          clearTimeout(fallback);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    for (const s of steps) io.observe(s);
    return () => {
      clearTimeout(fallback);
      io.disconnect();
    };
  }, []);

  // Link-click feedback: briefly highlight the section.
  useEffect(() => {
    const onPulse = () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
      setFlash(false);
      timers.current.push(window.setTimeout(() => setFlash(true), 40));
      timers.current.push(window.setTimeout(() => setFlash(false), 1800));
    };
    window.addEventListener('how-pulse', onPulse);
    return () => {
      window.removeEventListener('how-pulse', onPulse);
      for (const t of timers.current) clearTimeout(t);
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      aria-label="How it works"
      id="how"
      className={`scroll-mt-6${flash ? ' how-flash' : ''}`}
    >
      <p className="mile-label">Mile 003 · How it works</p>
      <h2 className="font-display mt-2 text-2xl font-extrabold sm:text-3xl">
        From camera to decision in four steps
      </h2>

      <div className="mt-6 flex flex-col gap-10">
        {/* 1 · Camera sees */}
        <div className="how-step grid grid-cols-1 items-center gap-4 md:grid-cols-2">
          <div className="rise relative overflow-hidden rounded-xl border border-slate-700">
            <Image
              src="/landing/still-crash-1.jpg"
              alt="Blurred aerial still of a highway crash with an overturned truck"
              width={640}
              height={360}
              className="h-auto w-full"
            />
            <svg
              viewBox="0 0 640 360"
              aria-hidden="true"
              className="absolute inset-0 h-full w-full"
            >
              <rect className="sam-box sam-box-1" x="35" y="150" width="150" height="60" pathLength={1} />
              <text className="sam-box-label" x="35" y="142" fontSize="16" fontFamily="monospace">truck</text>
              <rect className="sam-box sam-box-2" x="190" y="150" width="70" height="75" pathLength={1} />
              <text className="sam-box-label" x="190" y="142" fontSize="16" fontFamily="monospace">truck</text>
              <rect className="sam-box sam-box-3" x="35" y="88" width="48" height="24" pathLength={1} />
              <text className="sam-box-label" x="35" y="80" fontSize="16" fontFamily="monospace">car</text>
            </svg>
          </div>
          <div>
            <p className="rise font-landing-mono text-xs uppercase tracking-widest text-sky-300">
              Step 1 · SAM 3.1
            </p>
            <h3 className="rise font-display mt-1 text-xl font-bold" style={{ transitionDelay: '60ms' }}>
              Camera sees
            </h3>
            <p className="rise mt-2 leading-relaxed text-slate-300 sm:text-[17px]" style={{ transitionDelay: '120ms' }}>
              Road and dash cameras watch the road. SAM 3.1 finds and tracks
              every vehicle, responder and person in the clip.
            </p>
            <p className="rise mt-2 text-xs text-slate-400" style={{ transitionDelay: '180ms' }}>
              Boxes illustrate tracking — the counts are real: 9 trucks and 3
              people in this clip (eval Table 1).
            </p>
          </div>
        </div>

        {/* 2 · AI checks */}
        <div className="how-step grid grid-cols-1 items-center gap-4 md:grid-cols-2">
          <div className="rise relative overflow-hidden rounded-xl border border-slate-700 md:order-2">
            <Image
              src="/landing/still-responders-1.jpg"
              alt="Blurred aerial still of an intersection with fire trucks on scene"
              width={640}
              height={360}
              className="h-auto w-full"
            />
            <p className="verdict-chip absolute bottom-3 left-3 rounded-full bg-slate-900/90 px-3 py-1 text-sm font-semibold text-white ring-1 ring-slate-500">
              crash · responders on scene
            </p>
          </div>
          <div className="md:order-1">
            <p className="rise font-landing-mono text-xs uppercase tracking-widest text-sky-300">
              Step 2 · Muse Spark
            </p>
            <h3 className="rise font-display mt-1 text-xl font-bold" style={{ transitionDelay: '60ms' }}>
              AI checks
            </h3>
            <p className="rise mt-2 leading-relaxed text-slate-300 sm:text-[17px]" style={{ transitionDelay: '120ms' }}>
              Muse Spark reads the scene and returns a structured verdict —
              type, severity, responders, evidence — and rejects false alarms:
              8 out of 8 normal clips cleared.
            </p>
          </div>
        </div>

        {/* 3 · AI tracks */}
        <div className="how-step grid grid-cols-1 items-center gap-4 md:grid-cols-2">
          <TrackCounter />
          <div>
            <p className="rise font-landing-mono text-xs uppercase tracking-widest text-sky-300">
              Step 3 · Muse Wonder
            </p>
            <h3 className="rise font-display mt-1 text-xl font-bold" style={{ transitionDelay: '60ms' }}>
              AI tracks
            </h3>
            <p className="rise mt-2 leading-relaxed text-slate-300 sm:text-[17px]" style={{ transitionDelay: '120ms' }}>
              The incident agent follows one crash across camera reports and
              narrows the clearance range with cited evidence: likely 72 → 36
              → 10 minutes.
            </p>
          </div>
        </div>

        {/* 4 · You decide */}
        <div className="how-step grid grid-cols-1 items-center gap-4 md:grid-cols-2">
          <div className="rd-card rise flex flex-col gap-2 p-4 md:order-2" style={{ transitionDelay: '150ms' }}>
            <p className="decide-best rounded-md border border-slate-600 px-3 py-2 text-sm">
              <span className="font-bold">Reroute via CT-15</span>
              <span className="ml-2 font-semibold text-emerald-300">· Best ✓</span>
              <br />
              <span className="text-slate-300">Arrive 10:38 AM</span>
            </p>
            <p className="rounded-md border border-slate-600 px-3 py-2 text-sm">
              <span className="font-bold">Stay on I-95 S</span>
              <br />
              <span className="text-slate-300">Arrive 11:19 AM</span>
            </p>
            <p className="rounded-md border border-slate-600 px-3 py-2 text-sm">
              <span className="font-bold">Wait at the rest stop</span>
              <br />
              <span className="text-slate-300">Sit out the worst of it</span>
            </p>
            <p className="text-sm font-semibold">Decide by Exit 38</p>
          </div>
          <div className="md:order-1">
            <p className="rise font-landing-mono text-xs uppercase tracking-widest text-sky-300">
              Step 4 · Route engine × Muse Wonder
            </p>
            <h3 className="rise font-display mt-1 text-xl font-bold" style={{ transitionDelay: '60ms' }}>
              You decide
            </h3>
            <p className="rise mt-2 leading-relaxed text-slate-300 sm:text-[17px]" style={{ transitionDelay: '120ms' }}>
              Stay, reroute or wait — scored against the clearance range from
              your position, with the exit where you must choose.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
