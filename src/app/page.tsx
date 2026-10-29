import Image from 'next/image';
import Link from 'next/link';

import shot from '../../docs/sim-warning.png';

const STEPS = [
  { name: 'SAM 3.1 sees', text: 'Finds and tracks every car, responder, cone and person.' },
  { name: 'Muse Spark judges', text: 'Reads the scene: crash, severity, evidence timestamps.' },
  { name: 'Muse Wonder tracks', text: 'Follows the incident across cameras; predicts clearing.' },
  { name: 'You decide', text: 'Stay, reroute or wait — before you reach the scene.' },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-stone-900">Daari Sentinel</h1>
        <p className="text-stone-700">
          Road cameras — dashcams in cars and roadside traffic cameras — become an early
          incident warning: cameras see the crash, and drivers behind get a stay / reroute /
          wait decision before they reach it.
        </p>
      </header>

      <Image
        src={shot}
        alt="Warning card on the simulated drive: crash ahead, clearance range and three options"
        className="h-auto w-full rounded-lg border border-stone-200"
        priority
      />

      <nav className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/sim?demo=1"
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-md bg-blue-700 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-800"
        >
          Watch the I-95 demo
        </Link>
        <Link
          href="/try"
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-blue-700 px-4 py-2 text-center text-sm font-semibold text-blue-700 hover:bg-blue-50"
        >
          Try your own clip
        </Link>
        <Link
          href="/lab"
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-stone-300 px-4 py-2 text-center text-sm font-semibold text-stone-700 hover:bg-stone-100"
        >
          Under the hood
        </Link>
      </nav>

      <section aria-label="How it works">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">
          How it works
        </h2>
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.name} className="rounded-lg border border-stone-200 bg-white p-3">
              <p className="text-sm font-bold text-stone-900">
                {i + 1}. {s.name}
              </p>
              <p className="mt-1 text-xs text-stone-600">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="flex flex-col gap-1 border-t border-stone-200 pt-4 text-xs text-stone-500 sm:flex-row sm:justify-between">
        <a
          className="underline hover:text-stone-700"
          href="https://github.com/ChaitanyaReddy01/daari-sentinel"
        >
          GitHub
        </a>
        <p>Built with Meta models for the Meta Global AI Developer Hackathon.</p>
      </footer>
    </main>
  );
}
