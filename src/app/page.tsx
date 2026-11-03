import type { Metadata } from 'next';
import Link from 'next/link';

import { TRY_DAILY_BUDGET_USD, TRY_MAX_PER_IP } from '@/lib/try-limits';

import { ArchDiagram } from './landing/arch-diagram';
import { HeroScene } from './landing/hero-scene';
import { HowLink, HowSection } from './landing/how-story';
import { CountUp, RevealGroup } from './landing/reveal';

export const metadata: Metadata = {
  title: "Daari Sentinel: know what's ahead, and when it clears",
  description:
    'Road cameras spot incidents. Meta AI tells drivers behind what happened, when it clears, and whether to stay, reroute or wait.',
};

const EVIDENCE = 'https://github.com/ChaitanyaReddy01/daari-sentinel/blob/main/docs/evidence';

const RECEIPTS: Array<{ tokens: Array<string | number>; label: string; href: string }> = [
  { tokens: [19, '/', 19], label: 'incidents detected', href: `${EVIDENCE}/detection.md` },
  { tokens: [0], label: 'false alarms on 8 normal-traffic clips', href: `${EVIDENCE}/detection.md` },
  { tokens: [11, '/', 11], label: 'incident clips caught by the quick check (median $0.0002 per look)', href: `${EVIDENCE}/triage.md` },
  { tokens: [72, ' → ', 36, ' → ', 10], label: 'min: the clearance estimate narrowing as reports arrive', href: `${EVIDENCE}/agent.md` },
  { tokens: ['~$', 0.33], label: 'per hour of driving (estimate — 1 look/min, 5% escalate)', href: `${EVIDENCE}/triage.md` },
  { tokens: [1, ' → ', 11], label: 'camera report → drivers alerted, ~3.2 driver-hours saved (simulation)', href: `${EVIDENCE}/network.md` },
];

const QA = [
  {
    q: "Isn't this just an image analyzer?",
    a: "No: it tracks one incident across many camera reports over time, estimates when it clears with cited evidence, and turns that into a route decision for every driver whose path crosses it; a guard rejects claims the evidence doesn't support.",
  },
  {
    q: 'How accurate is the clearance time?',
    a: "Honest answer: it's an AI estimate anchored to planning defaults per incident type and stage, adjusted with cited evidence. It narrows as reports arrive, but it has not been validated against real clearance records yet.",
  },
  {
    q: 'Why not run the AI on every frame?',
    a: 'The triage ladder: a sub-cent quick look about once a minute (median $0.0002); full checks only when something looks wrong; map updates only when the stage changes.',
  },
  {
    q: "What's live and what's replayed?",
    a: `The demos replay cached real model results ($0); /try runs live calls with quotas and a daily cap (${TRY_MAX_PER_IP} free tries per IP per day, $${TRY_DAILY_BUDGET_USD} total daily budget).`,
  },
  {
    q: 'What about privacy?',
    a: 'Faces and plates are blurred in every image shown, including uploads; uploads are deleted after analysis.',
  },
  {
    q: 'What does it cost?',
    a: 'Quick look median $0.0002, full check $0.106, about $0.33 per driving hour at a 5% escalation rate — and $11.55 of Meta API spend for building and testing (models only, excludes coding-agent usage). See the receipts.',
  },
];

const LIMITS = [
  'Clearance times are estimates, not validated against real incident records.',
  'Most incident footage is stock video (aerial or traffic-camera style) standing in for one incident; the demo is a simulation, not a live fleet.',
  'The quick look over-flags some heavy traffic and crowds (safe direction, costs extra checks).',
  "SAM's video tracking caps at 16 objects per frame; true counts come from stills.",
  'Community reports are an early demo with simple abuse limits.',
];

const MODELS = [
  { name: 'SAM 3.1', job: 'Finds and tracks every vehicle and responder' },
  { name: 'Muse Spark', job: 'Reads the scene, rejects false alarms' },
  { name: 'Muse Wonder', job: 'Tracks the incident until it clears' },
  { name: 'Muse Code', job: 'Wrote this repo' },
];

export default function Home() {
  return (
    <div className="landing-root min-h-dvh">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-4 py-6 pb-16">
        {/* Top bar */}
        <header className="flex items-center justify-between gap-4">
          <p className="font-display text-lg font-extrabold tracking-tight">Daari Sentinel</p>
          <nav className="flex items-center gap-4 text-sm" aria-label="Top">
            <Link href="/judge" className="font-semibold text-sky-300 underline hover:text-white">
              Judge path
            </Link>
            <a
              href="https://github.com/ChaitanyaReddy01/daari-sentinel"
              className="font-semibold text-sky-300 underline hover:text-white"
            >
              GitHub
            </a>
          </nav>
        </header>

        {/* Hero */}
        <section aria-label="Introduction" className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
          <div>
            <h1 className="font-display text-4xl font-black leading-tight tracking-tight sm:text-5xl">
              A crash is ahead. <em className="text-amber-300">The clock is what matters.</em>
            </h1>
            <p className="mt-4 text-base leading-relaxed text-slate-300">
              Road cameras spot incidents. SAM 3.1 finds the vehicles and responders, Muse
              Spark rejects false alarms, Muse Wonder tracks the scene until it clears, so
              drivers behind know what happened, when it ends, and what to do.
            </p>
            <p className="font-landing-mono mt-4 text-sm text-emerald-300">
              19/19 incidents detected · 0 false alarms on normal traffic · estimate narrows
              72 → 10 min as cameras pass
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                href="/sim?demo=1"
                className="flex min-h-[48px] items-center justify-center rounded-md bg-amber-500 px-6 py-2 text-center text-base font-bold text-slate-950 hover:bg-amber-400"
              >
                Watch the 60-second demo
              </Link>
              <Link
                href="/try"
                className="flex min-h-[48px] items-center justify-center rounded-md border border-sky-300 px-6 py-2 text-center text-base font-semibold text-sky-200 hover:bg-slate-800"
              >
                Try your own clip
              </Link>
              <Link
                href="/judge"
                className="flex min-h-[48px] items-center justify-center rounded-md border border-slate-500 px-6 py-2 text-center text-base font-semibold text-slate-200 hover:bg-slate-800"
              >
                Judge path
              </Link>
            </div>
            <p className="mt-3 text-sm">
              <HowLink />
            </p>
          </div>
          <div className="rd-card p-3">
            <HeroScene />
          </div>
        </section>

        {/* Mile 001 · Today vs Sentinel */}
        <section aria-label="Today versus Sentinel">
          <RevealGroup>
            <p className="mile-label rv">Mile 001 · The gap</p>
            <h2 className="font-display rv mt-2 text-2xl font-extrabold sm:text-3xl" style={{ transitionDelay: '80ms' }}>
              Today vs Sentinel
            </h2>
          </RevealGroup>
          <RevealGroup className="mt-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rd-card rv vs-fade p-4 opacity-90">
                <p className="font-landing-mono text-xs uppercase tracking-widest text-slate-400">
                  A generic maps alert
                </p>
                <p className="mt-2 text-lg font-semibold text-slate-300">
                  ⚠ Crash reported · 12 min delay
                </p>
              </div>
              <div className="rd-card rv vs-slide p-4 ring-1 ring-amber-300" style={{ transitionDelay: '200ms' }}>
                <p className="font-landing-mono text-xs uppercase tracking-widest text-amber-300">
                  Daari Sentinel
                </p>
                <p className="mt-2 text-lg font-bold">
                  Crash ahead · tow truck working · clears in about 10 min
                </p>
                <p className="mt-1 text-base text-emerald-300">
                  ✅ Best: stay · Decide by Exit 38
                </p>
              </div>
            </div>
            <p className="rv mt-3 text-sm text-slate-300" style={{ transitionDelay: '320ms' }}>
              Maps know something happened. Sentinel knows what stage it&apos;s at and when it ends.
            </p>
          </RevealGroup>
        </section>

        {/* Mile 002 · Receipts */}
        <section aria-label="Receipts" id="receipts" className="scroll-mt-6">
          <RevealGroup>
            <p className="mile-label rv">Mile 002 · Receipts</p>
            <h2 className="font-display rv mt-2 text-2xl font-extrabold sm:text-3xl" style={{ transitionDelay: '80ms' }}>
              Don&apos;t take our word for it
            </h2>
          </RevealGroup>
          <RevealGroup className="mt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {RECEIPTS.map((r, i) => (
                <a
                  key={r.label}
                  href={r.href}
                  className="rd-card rv block p-4 hover:border-amber-300"
                  style={{ transitionDelay: `${i * 80}ms` }}
                >
                  <p className="font-landing-mono text-3xl font-semibold tabular-nums text-amber-300">
                    <CountUp tokens={r.tokens} />
                  </p>
                  <p className="mt-2 text-sm text-slate-200">{r.label}</p>
                  <p className="mt-2 text-xs font-semibold text-sky-300 underline">
                    Evidence →
                  </p>
                </a>
              ))}
            </div>
          </RevealGroup>
          <p className="mt-3 text-sm text-slate-300">
            Meta API spend for building and testing the app&apos;s AI features (models
            only — excludes coding-agent usage):{' '}
            <span className="font-landing-mono font-semibold text-white">$11.55</span>{' '}
            (
            <a
              href={`${EVIDENCE}/costs.md`}
              className="font-semibold text-sky-300 underline hover:text-white"
            >
              costs.md
            </a>
            ).
          </p>
        </section>

        <HowSection />

        {/* Mile 004 · Architecture */}
        <section aria-label="Architecture">
          <RevealGroup>
            <p className="mile-label rv">Mile 004 · Architecture</p>
            <h2 className="font-display rv mt-2 text-2xl font-extrabold sm:text-3xl" style={{ transitionDelay: '80ms' }}>
              The pipeline
            </h2>
          </RevealGroup>
          <div className="mt-4">
            <ArchDiagram />
          </div>
          <p className="mt-3 text-sm text-slate-300">
            <a
              href="https://github.com/ChaitanyaReddy01/daari-sentinel#how-it-works"
              className="font-semibold text-sky-300 underline hover:text-white"
            >
              The pipeline in the README →
            </a>
          </p>
        </section>

        {/* Mile 005 · Judge Q&A */}
        <section aria-label="Questions a judge would ask">
          <RevealGroup>
            <p className="mile-label rv">Mile 005 · Judge Q&amp;A</p>
            <h2 className="font-display rv mt-2 text-2xl font-extrabold sm:text-3xl" style={{ transitionDelay: '80ms' }}>
              Questions a judge would ask
            </h2>
          </RevealGroup>
          <RevealGroup className="mt-4 flex flex-col gap-2">
            {QA.map((item, i) => (
              <details
                key={item.q}
                className="rd-qa rv p-4"
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                <summary className="text-base">
                  <span aria-hidden="true" className="qa-marker">▸</span>
                  {item.q}
                </summary>
                <p className="mt-2 pl-6 text-sm leading-relaxed text-slate-300">{item.a}</p>
              </details>
            ))}
          </RevealGroup>
        </section>

        {/* Mile 006 · Honest limits */}
        <section aria-label="What this doesn't prove yet" id="limits" className="scroll-mt-6">
          <RevealGroup>
            <p className="mile-label rv">Mile 006 · Honest limits</p>
            <h2 className="font-display rv mt-2 text-2xl font-extrabold sm:text-3xl" style={{ transitionDelay: '80ms' }}>
              What this doesn&apos;t prove yet
            </h2>
          </RevealGroup>
          <RevealGroup className="mt-4">
            <ul className="flex flex-col gap-2">
              {LIMITS.map((l, i) => (
                <li
                  key={l}
                  className="rd-card rv flex gap-3 p-4 text-sm leading-relaxed text-slate-200"
                  style={{ transitionDelay: `${i * 80}ms` }}
                >
                <span aria-hidden="true" className="font-bold text-amber-300">—</span>
                {l}
              </li>
              ))}
            </ul>
          </RevealGroup>
        </section>

        {/* Mile 007 · Built with Meta + CTA */}
        <section aria-label="Built with Meta">
          <RevealGroup>
            <p className="mile-label rv">Mile 007 · Built with Meta</p>
            <h2 className="font-display rv mt-2 text-2xl font-extrabold sm:text-3xl" style={{ transitionDelay: '80ms' }}>
              Four models, four jobs
            </h2>
          </RevealGroup>
          <RevealGroup className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {MODELS.map((m, i) => (
              <div
                key={m.name}
                className="rd-card rv p-4"
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                <p className="font-display text-base font-extrabold">{m.name}</p>
                <p className="mt-1 text-sm text-slate-300">{m.job}</p>
              </div>
            ))}
          </RevealGroup>
          <RevealGroup className="mt-8">
            <div className="rd-card rv p-6 text-center">
            <h2 className="font-display text-2xl font-extrabold sm:text-3xl">See it in action</h2>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-center sm:flex-wrap">
              <Link
                href="/sim?demo=1"
                className="flex min-h-[48px] items-center justify-center rounded-md bg-amber-500 px-6 py-2 text-center text-base font-bold text-slate-950 hover:bg-amber-400"
              >
                Watch the 60-second demo
              </Link>
              <Link
                href="/try"
                className="flex min-h-[48px] items-center justify-center rounded-md border border-sky-300 px-6 py-2 text-center text-base font-semibold text-sky-200 hover:bg-slate-800"
              >
                Try your own clip
              </Link>
              <Link
                href="/judge"
                className="flex min-h-[48px] items-center justify-center rounded-md border border-slate-500 px-6 py-2 text-center text-base font-semibold text-slate-200 hover:bg-slate-800"
              >
                Judge path
              </Link>
            </div>
            </div>
          </RevealGroup>
        </section>

        <footer className="flex flex-col gap-2 border-t border-slate-700 pt-4 text-sm text-slate-400">
          <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Footer">
            <Link href="/lab" className="font-semibold text-slate-300 underline hover:text-white">
              Under the hood
            </Link>
            <a
              href="https://github.com/ChaitanyaReddy01/daari-sentinel"
              className="underline hover:text-slate-200"
            >
              GitHub
            </a>
            <Link href="/judge" className="underline hover:text-slate-200">
              Judge path
            </Link>
            <a
              href="https://github.com/ChaitanyaReddy01/daari-sentinel#footage-credits"
              className="underline hover:text-slate-200"
            >
              Footage credits
            </a>
          </nav>
          <p className="text-xs">
            Prototype, built solo for the Meta Global AI Developer Hackathon.
          </p>
        </footer>
      </main>
    </div>
  );
}
