/**
 * Step 10 shared presentation helpers: plain-language phrases, the Maya
 * story copy, and tiny animation hooks. Pure display mapping only — no
 * pipeline, agent, guard, triage, routing, board, quota or cost logic.
 */

import { useEffect, useRef, useState } from 'react';

/** Incident type code -> headline noun. Unknown codes read as a hazard. */
export function typePhrase(type: string): string {
  switch (type) {
    case 'crash':
      return 'Crash';
    case 'police_activity':
      return 'Police activity';
    case 'construction':
      return 'Work zone';
    case 'fire':
      return 'Fire';
    default:
      return 'Hazard';
  }
}

/**
 * Verdict stage code -> plain phrase. Returns null for not_applicable so
 * callers hide it.
 */
export function stagePhrase(stage: string): string | null {
  switch (stage) {
    case 'no_responders':
      return 'no help on scene yet';
    case 'responders_on_scene':
      return 'police and fire on scene';
    case 'tow_in_progress':
      return 'tow truck working';
    case 'clearing':
      return 'almost clear';
    case 'cleared':
      return 'clear';
    case 'not_applicable':
      return null;
    default:
      return stage.replace(/_/g, ' ');
  }
}

/** Assessment confidence -> plain phrase. */
export function confidencePhrase(confidence: string): string {
  switch (confidence) {
    case 'high':
      return 'fairly sure';
    case 'medium':
      return 'likely';
    default:
      return 'not sure yet';
  }
}

/** Triage ladder level -> plain phrase (no "Level N" in user copy). */
export function checkPhrase(level: 1 | 2 | 3): string {
  switch (level) {
    case 1:
      return 'quick check';
    case 2:
      return 'full check';
    default:
      return 'tracking';
  }
}

/** "1:05 PM" -> minutes after midnight. Null when unparseable. */
export function clockToMin(clock: string): number | null {
  const m = clock.trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return null;
  const pm = m[3].toUpperCase() === 'PM';
  h = h % 12;
  if (pm) h += 12;
  return h * 60 + min;
}

// ---- Maya story (I-95 demo) ----

/** Maya's flight; arrivals before the cutoff still make it comfortably. */
export const FLIGHT_CLOCK = '2:00 PM';
export const FLIGHT_CUTOFF_MIN = 13 * 60 + 15; // 1:15 PM

export const FLIGHT_LINE = `you'll still make your ${FLIGHT_CLOCK} flight`;

/** Guided Demo captions, in story order (index 4 = road clear). */
export const DEMO_CAPTIONS = [
  'Maya is driving New Haven → JFK for a 2 PM flight',
  'A road camera ahead spots a crash',
  "Here's her best choice",
  'Tow truck arrived, so it clears sooner',
  'Road clear, back to normal',
] as const;

/** Network demo opening caption; it ends with the live result line. */
export const NET_CAPTION_OPEN = "Maya's dashcam spots a crash. Who does it help?";

/** One-line network result for the main panel. */
export function netResultLine(notified: number, savedDriverMin: number): string {
  const drivers = `${notified} driver${notified === 1 ? '' : 's'}`;
  if (savedDriverMin >= 60) {
    return `Maya's camera helped ${drivers}, about ${(savedDriverMin / 60).toFixed(1)} hours saved.`;
  }
  return `Maya's camera helped ${drivers}, about ${Math.max(1, Math.round(savedDriverMin))} min saved.`;
}

/** True when the OS asks for reduced motion (checked live, SSR-safe). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Live reduced-motion flag for components (updates if the OS setting flips). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(q.matches);
    q.addEventListener('change', onChange);
    return () => q.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Animate a displayed number toward its target over `durationMs` (ease-out).
 * Jumps instantly under reduced motion. Retargets mid-flight; unmount-safe.
 */
export function useAnimatedNumber(target: number, durationMs: number): number {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const rafRef = useRef(0);
  useEffect(() => {
    if (reduced || durationMs <= 0) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const from = shownRef.current;
    if (from === target) return;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - (1 - p) * (1 - p);
      const v = from + (target - from) * eased;
      shownRef.current = v;
      setShown(v);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, durationMs, reduced]);
  return shown;
}
