'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pipeline diagram (vertical: readable at 390 px and desktop). When it
 * scrolls into view the boxes light one by one (~600 ms each): the active
 * box fills with its accent color and glows, a dash flows down the arrow
 * to the next box, and a tiny caption appears under each lit box. Already
 * lit boxes stay softly tinted. Reduced motion: everything lit, no motion.
 */
const NODES = [
  { name: 'Road camera clip', sub: 'dashcam · traffic cam', accent: '#3b82f6', soft: 'rgba(59,130,246,0.16)', caption: '' },
  { name: 'Quick check', sub: 'Muse Spark', accent: '#f59e0b', soft: 'rgba(245,158,11,0.16)', caption: '≈ once a minute, $0.0002' },
  { name: 'Full check', sub: 'SAM 3.1 + Muse Spark, cross-checked', accent: '#f59e0b', soft: 'rgba(245,158,11,0.16)', caption: 'only if something looks wrong' },
  { name: 'Incident agent', sub: 'Muse Wonder', accent: '#a78bfa', soft: 'rgba(167,139,250,0.18)', caption: 'only if an incident is confirmed' },
  { name: 'Guard', sub: 'evidence rules', accent: '#2dd4bf', soft: 'rgba(45,212,191,0.14)', caption: 'rejects claims without evidence' },
  { name: 'Map + route decision', sub: 'stay · reroute · wait', accent: '#60a5fa', soft: 'rgba(96,165,250,0.16)', caption: 'only on real changes' },
  { name: 'Drivers behind', sub: 'warned before the scene', accent: '#22c55e', soft: 'rgba(34,197,94,0.16)', caption: "only drivers who'd hit it" },
];

const NODE_H = 58;
const GAP = 56;
const W = 400;
const STEP_MS = 600;

export function ArchDiagram() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  // step: index of the active box; NODES.length = finished (all softly lit).
  const [step, setStep] = useState(-1);
  const [runId, setRunId] = useState(0);

  const clearTimers = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };

  const run = useCallback(() => {
    clearTimers();
    setStep(0);
    for (let i = 1; i <= NODES.length; i++) {
      timers.current.push(window.setTimeout(() => setStep(i), i * STEP_MS));
    }
  }, []);

  const replay = useCallback(() => {
    setRunId((r) => r + 1);
    run();
  }, [run]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Reduced motion (or no observer): final state, no animation.
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setStep(NODES.length);
      return;
    }
    const fallback = window.setTimeout(run, 2500);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          window.clearTimeout(fallback);
          io.disconnect();
          run();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => {
      window.clearTimeout(fallback);
      io.disconnect();
      clearTimers();
    };
  }, [run]);

  const h = NODES.length * NODE_H + (NODES.length - 1) * GAP + 64;
  return (
    <div ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${h}`}
        role="img"
        aria-label="Pipeline diagram: road camera clip, quick check by Muse Spark, full check by SAM 3.1 plus Muse Spark, incident agent by Muse Wonder, guard, map and route decision, drivers behind."
        className="mx-auto h-auto w-full max-w-md"
      >
        <defs>
          <marker id="rd-arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#fcd34d" />
          </marker>
        </defs>
        {NODES.map((n, i) => {
          const y = 8 + i * (NODE_H + GAP);
          const lit = step > i;
          const active = step === i;
          const ink = active ? '#0a1428' : '#f8fafc';
          const subInk = active ? '#0a1428' : '#93c5fd';
          const flowing = step === i + 1;
          return (
            <g key={n.name}>
              <rect
                className="rd-node"
                x="8"
                y={y}
                width={W - 16}
                height={NODE_H}
                rx="10"
                fill={active ? n.accent : lit ? n.soft : '#101e38'}
                stroke={active || lit ? n.accent : '#3b537f'}
                strokeWidth={active ? 2.5 : 1.5}
                style={
                  {
                    ...(active ? { filter: `drop-shadow(0 0 8px ${n.accent})` } : null),
                    '--rd-soft': n.soft,
                    '--rd-accent': n.accent,
                  } as React.CSSProperties
                }
              />
              <text x="24" y={y + 25} fill={ink} fontSize="14" fontWeight="700">
                {n.name}
              </text>
              <text x="24" y={y + 44} fill={subInk} fontSize="12" fontFamily="monospace">
                {n.sub}
              </text>
              {i < NODES.length - 1 && (
                <line
                  key={`${runId}-${i}`}
                  x1={W / 2}
                  y1={y + NODE_H + 4}
                  x2={W / 2}
                  y2={y + NODE_H + 26}
                  stroke="#fcd34d"
                  strokeWidth="2"
                  markerEnd="url(#rd-arrow)"
                  className={flowing ? 'rd-flow' : undefined}
                />
              )}
              {n.caption !== '' && (
                <text
                  x="24"
                  y={y + NODE_H + 48}
                  fill="#94a3b8"
                  fontSize="11"
                  fontFamily="monospace"
                  className="rd-caption"
                  opacity={lit || active ? 1 : 0}
                >
                  {n.caption}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="mt-2 text-center text-sm">
        <button
          type="button"
          onClick={replay}
          aria-label="Replay pipeline animation"
          className="font-semibold text-sky-300 underline hover:text-white"
        >
          Replay ↻
        </button>
      </p>
    </div>
  );
}
