'use client';

import { useEffect, useRef, useState } from 'react';

const STEPS = [
  {
    name: 'Camera sees',
    text: 'Road and dash cameras watch the road ahead.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" className="h-6 w-6">
        <rect x="2.5" y="7" width="12" height="10" rx="2" />
        <path d="M14.5 10.5 20 7.5v9l-5.5-3" strokeLinejoin="round" />
        <circle cx="8.5" cy="12" r="2.4" />
      </svg>
    ),
  },
  {
    name: 'AI checks',
    text: 'Each sighting is checked before it reaches the map.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" className="h-6 w-6">
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="M15.2 15.2 20 20" strokeLinecap="round" />
        <path d="M8 10.5l1.8 1.8 3.2-3.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    name: 'AI tracks',
    text: 'Follow-up cameras narrow down when it clears.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" className="h-6 w-6">
        <path d="M4 17c3-1 4-3 4-6s2-6 5-6c1.5 0 2.5.5 3.5 1.5" strokeLinecap="round" />
        <circle cx="4" cy="17" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="12" cy="9" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="19" cy="9" r="1.6" fill="currentColor" stroke="none" />
        <path d="M15 14.5h4M17 12.5v4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    name: 'You decide',
    text: 'Stay, reroute or wait — before you reach it.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" className="h-6 w-6">
        <path d="M12 3v6" strokeLinecap="round" />
        <path d="M12 9C12 13 8 13.5 5 16c-1.5 1.2-2 2-2.2 3" strokeLinecap="round" />
        <path d="M12 9c0 4 4 4.5 7 7 1.5 1.2 2 2 2.2 3" strokeLinecap="round" />
        <circle cx="12" cy="9" r="1.6" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
];

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
      className="font-semibold text-blue-700 underline hover:text-blue-800"
    >
      How it works
    </a>
  );
}

/** How-it-works strip: scroll reveal plus the link-click highlight. */
export function HowSection() {
  const stripRef = useRef<HTMLOListElement>(null);
  const [flash, setFlash] = useState(false);
  const timers = useRef<number[]>([]);

  // Reveal the steps once, in sequence, when scrolled into view. The steps
  // must never stay invisible: reduced motion, a missing observer, or a
  // stalled observer all show them immediately (at most 1.5 s in).
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>('.reveal'));
    if (items.length === 0) return;
    const show = () => {
      for (const item of items) item.classList.add('on');
    };
    if (
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
      typeof IntersectionObserver === 'undefined'
    ) {
      show();
      return;
    }
    const fallback = setTimeout(show, 1500);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            clearTimeout(fallback);
            show();
            io.disconnect();
          }
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => {
      clearTimeout(fallback);
      io.disconnect();
    };
  }, []);

  // Link-click feedback: briefly highlight the section (clearly visible even
  // when the page cannot scroll). Retriggerable on every click.
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
      aria-label="How it works"
      id="how"
      className={`scroll-mt-6${flash ? ' how-flash' : ''}`}
    >
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">
        How it works
      </h2>
      <ol ref={stripRef} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        {STEPS.map((s, i) => (
          <li
            key={s.name}
            className="reveal rounded-lg border border-stone-200 bg-white p-3"
            style={{ transitionDelay: `${i * 90}ms` }}
          >
            <div className="flex items-center gap-2 text-blue-700">
              {s.icon}
              <p className="text-sm font-bold text-stone-900">{s.name}</p>
            </div>
            <p className="mt-1 text-xs text-stone-600">{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
