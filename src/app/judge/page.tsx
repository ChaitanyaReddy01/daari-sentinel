import type { Metadata } from 'next';
import Link from 'next/link';

import { TRY_MAX_PER_IP } from '@/lib/try-limits';

export const metadata: Metadata = {
  title: 'Daari Sentinel judge path: the 3-minute tour',
  description:
    'Seven steps through the demo, the network effect, your own clip, the receipts and the code.',
};

const STEPS = [
  {
    title: 'Watch the 60-second demo',
    href: '/sim?demo=1',
    look: 'Follow the captions: a road camera spots a crash, Maya gets her best choice, then the road clears.',
  },
  {
    title: 'Open “Why?” on the alert',
    href: '/sim?demo=1',
    look: 'The photo, the range in words, Decide by Exit 38, the evidence chips — every claim plays its frame.',
  },
  {
    title: 'Try Reroute',
    href: '/sim?demo=1',
    look: 'The blue detour draws from the car while the old road fades to gray dashed.',
  },
  {
    title: 'Play the network demo',
    href: '/sim',
    look: 'One dashcam report near Norwalk — watch how many drivers it helps and how much time it saves.',
  },
  {
    title: 'Try your own clip',
    href: '/try',
    look: `A headline first, details behind “Show details”. Note the quota: ${TRY_MAX_PER_IP} free tries per day.`,
  },
  {
    title: 'Read the receipts and the limits',
    href: '/#receipts',
    look: 'Every big number links to its evidence file; the limits section says what nothing proves yet.',
  },
  {
    title: 'The code and the evaluation',
    href: 'https://github.com/ChaitanyaReddy01/daari-sentinel',
    look: 'Batch report, agent checks and triage eval — all committed, all re-runnable.',
  },
];

export default function Judge() {
  return (
    <div className="landing-root min-h-dvh">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 pb-16">
        <header className="flex items-center justify-between gap-4">
          <Link href="/" className="font-display text-lg font-bold tracking-tight">
            Daari Sentinel
          </Link>
          <Link href="/" className="text-sm font-semibold text-[#7CB4FF] hover:text-white hover:underline">
            ← Back
          </Link>
        </header>

        <section aria-label="Judge path">
          <p className="mile-label">Judge path · 3 minutes</p>
          <h1 className="font-display mt-2 text-3xl font-bold leading-[1.1] tracking-tight sm:text-4xl">
            Seven steps, everything proven
          </h1>
          <p className="mt-3 text-sm">
            <Link href="/#howto" className="font-semibold text-[#7CB4FF] hover:text-white hover:underline">
              How to use it →
            </Link>
          </p>
          <ol className="mt-6 flex flex-col gap-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rd-card flex gap-4 p-4">
                <span
                  aria-hidden="true"
                  className="font-landing-mono text-2xl font-semibold text-amber-300"
                >
                  {i + 1}
                </span>
                <div>
                  <a
                    href={s.href}
                    className="text-base font-bold text-[#7CB4FF] hover:text-white hover:underline"
                  >
                    {s.title} →
                  </a>
                  <p className="mt-1 text-base leading-relaxed text-slate-300 sm:text-[17px]">{s.look}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <footer className="border-t border-slate-700 pt-4 text-xs text-slate-400">
          Prototype, built solo for the Meta Global AI Developer Hackathon.
        </footer>
      </main>
    </div>
  );
}
