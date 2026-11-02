import type { Metadata } from 'next';
import Link from 'next/link';

import { HowLink, HowSection } from './how-works';

export const metadata: Metadata = {
  title: "Daari Sentinel: know what's ahead, and when it clears",
  description:
    'Road cameras spot incidents. Meta AI tells drivers behind what happened, when it clears, and whether to stay, reroute or wait.',
};

export default function Home() {
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
          <HowLink />
        </div>
      </nav>

      <HowSection />

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
