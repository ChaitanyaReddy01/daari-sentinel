'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

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

export default function Home() {
  const stripRef = useRef<HTMLOListElement>(null);

  // Reveal the how-it-works steps once, in sequence, when scrolled into view.
  // The steps must never stay invisible: reduced motion, a missing observer,
  // or a stalled observer all show them immediately (at most 1.5 s in).
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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-stone-500">Daari Sentinel</p>
        <h1 className="text-3xl font-bold tracking-tight text-stone-900 sm:text-4xl">
          Know what&apos;s ahead, and when it clears.
        </h1>
        <p className="text-base text-stone-700">
          Road cameras spot incidents. AI tells drivers behind what happened, when it clears,
          and what to do.
        </p>
      </header>

      <nav className="flex flex-col gap-3" aria-label="Get started">
        <Link
          href="/sim?demo=1"
          className="flex min-h-[48px] items-center justify-center rounded-md bg-blue-700 px-6 py-2 text-center text-base font-semibold text-white hover:bg-blue-800 sm:self-start"
        >
          Watch the 60-second demo
        </Link>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Link href="/try" className="font-semibold text-blue-700 underline hover:text-blue-800">
            Try your own clip
          </Link>
          <a href="#how" className="font-semibold text-blue-700 underline hover:text-blue-800">
            How it works
          </a>
        </div>
      </nav>

      <section aria-label="How it works" id="how" className="scroll-mt-6">
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

      <footer className="flex flex-col gap-1 border-t border-stone-200 pt-4 text-xs text-stone-500 sm:flex-row sm:items-center sm:gap-4">
        <Link href="/lab" className="font-semibold text-stone-600 underline hover:text-stone-800">
          Under the hood
        </Link>
        <a
          className="underline hover:text-stone-700"
          href="https://github.com/ChaitanyaReddy01/daari-sentinel"
        >
          GitHub
        </a>
        <p className="sm:ml-auto">Built with Meta models for the Meta Global AI Developer Hackathon.</p>
      </footer>
    </main>
  );
}
