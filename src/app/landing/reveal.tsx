'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Reveals descendants marked `.rv` (fade + 16 px rise, 400 ms) once the
 * group is ~20% in view. Children stagger via inline transition-delay.
 * Reduced motion, missing observer, or a 1.5 s fallback: show immediately.
 */
export function RevealGroup({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => el.classList.add('on');
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      show();
      return;
    }
    const fallback = window.setTimeout(show, 1500);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          show();
          window.clearTimeout(fallback);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => {
      window.clearTimeout(fallback);
      io.disconnect();
    };
  }, []);

  return <div ref={ref} className={`reveal-sec ${className}`.trim()}>{children}</div>;
}

function formatCount(target: number, t: number): string {
  const decimals = Number.isInteger(target) ? 0 : 2;
  return (target * t).toFixed(decimals);
}

/**
 * Counts every numeric token from 0 to its final value (600 ms ease-out)
 * when scrolled into view. Renders the final value on the server and with
 * reduced motion, so the numbers are never hidden from crawlers or readers.
 */
export function CountUp({ tokens }: { tokens: Array<string | number> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [t, setT] = useState(1);

  useEffect(() => {
    if (
      prefersReducedMotion() ||
      typeof IntersectionObserver === 'undefined' ||
      typeof requestAnimationFrame === 'undefined'
    ) {
      return;
    }
    setT(0);
    let raf = 0;
    let stopped = false;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.disconnect();
          const t0 = performance.now();
          const step = (now: number) => {
            if (stopped) return;
            const p = Math.min(1, (now - t0) / 600);
            setT(1 - (1 - p) * (1 - p));
            if (p < 1) raf = requestAnimationFrame(step);
          };
          raf = requestAnimationFrame(step);
        }
      },
      { threshold: 0.4 },
    );
    const el = ref.current;
    if (el) io.observe(el);
    return () => {
      stopped = true;
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <span ref={ref}>
      {tokens.map((tok, i) =>
        typeof tok === 'string' ? (
          <span key={i}>{tok}</span>
        ) : (
          <span key={i}>{formatCount(tok, t)}</span>
        ),
      )}
    </span>
  );
}
